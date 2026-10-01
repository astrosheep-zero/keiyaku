/** @architectureCompositionRoot */
import { localExecutionContext, type ExecutionContext } from "../akuma/requests.js";
import { renderContractGuidance } from "../contract-guidance.js";
import type { ContractId, ContractState } from "../core/facts/types.js";
import { readDispatchesAt } from "../dispatch/index.js";
import { mintSnapshotId } from "../git/identity.js";
import { observeContractsForAdmissionInObservationAt } from "../git/observe.js";
import { withGitDecodeChannel, withGitReadObservation } from "../git/read-observation.js";
import {
  contractObservationOperation,
  deliveryOperation,
  stateOperation,
  type RepositoryScope,
} from "../protocol/operations.js";
import { readManagedWorktreeAppointment } from "../workspace-place.js";
import { composeContractLibrary, readContractValue, type KeiyakuLibrary } from "./contract-composition.js";
import { ContractExecution } from "./contract-execution.js";
import type {
  AbandonOutcome,
  AmendOutcome,
  ArcOutcome,
  AuditInput,
  AuditOutcome,
  DeliverOutcome,
  MutationObservation,
  ReviewOutcome,
} from "./contract-outcomes.js";
import type { LocalContractCompositionCapture } from "./contract-settings.js";
import type {
  AbandonInput,
  AmendInput,
  ArcInput,
  ContractHistory,
  ContractHistoryEvent,
  DeliverInput,
  LocalContractComposition,
  ReviewInput,
} from "./contract-types.js";
import { deliveryForContract, type Delivery } from "./delivery.js";

const KEIYAKU_HANDLE = Symbol("Keiyaku handle");

type HandleSeat = Readonly<{ id: ContractId; scope: RepositoryScope }>;
const KEIYAKU_SEATS = new WeakMap<object, HandleSeat>();

export class Keiyaku {
  static with(input?: LocalContractComposition): KeiyakuLibrary {
    return composeContractLibrary(localExecutionContext(), createKeiyakuHandle, input);
  }

  private readonly id: ContractId;
  private readonly scope: RepositoryScope;
  private readonly operations: ContractExecution;

  constructor(
    token: typeof KEIYAKU_HANDLE,
    id: ContractId,
    scope: RepositoryScope,
    execution: ExecutionContext = localExecutionContext(),
    composition: LocalContractCompositionCapture,
  ) {
    if (token !== KEIYAKU_HANDLE) throw new TypeError("Keiyaku handles are created by Keiyaku.with");
    this.id = id;
    this.scope = scope;
    this.operations = new ContractExecution({ id, scope, execution, composition });
    // Process-local custody never serializes: identity-only JSON projection.
    Object.defineProperties(this, {
      id: { value: id, enumerable: false },
      scope: { value: scope, enumerable: false },
      execution: { value: execution, enumerable: false },
      operations: { value: this.operations, enumerable: false },
      composition: { value: composition, enumerable: false },
    });
    KEIYAKU_SEATS.set(this, { id, scope });
    Object.freeze(this);
  }

  /** The handle's one durable identity; everything else is process-local custody. */
  toJSON(): Readonly<{ contract: ContractId }> {
    return { contract: this.id };
  }

  async state(): Promise<ContractState | null> {
    return await this.read(() =>
      withGitDecodeChannel(this.scope, (channel) =>
        stateOperation({ scope: this.scope, channel, contractId: this.id }),
      ),
    );
  }

  async history(): Promise<ContractHistory | null> {
    return await this.read(() =>
      withGitDecodeChannel(this.scope, (channel) =>
        withGitReadObservation(this.scope, channel, async (observation) => {
          const [journals, dispatches] = await Promise.all([
            observeContractsForAdmissionInObservationAt(observation, [this.id]),
            readDispatchesAt(observation),
          ]);
          const record = journals.journals.get(this.id);
          if (record === undefined) throw new Error(`missing requested contract observation: ${this.id}`);
          if (record.state === null) return null;
          const commit = observation.snapshot.commit;
          if (commit === null) throw new Error("contract history requires a keiyaku-state snapshot");
          const recordedAt = (event: ContractHistoryEvent): string =>
            event.source === "journal" ? event.fact.at : event.dispatch.dispatchedAt;
          const events = [
            ...record.entries.map((fact) => ({ source: "journal" as const, fact })),
            ...dispatches
              .filter((dispatch) => dispatch.contractId === this.id)
              .map((dispatch) => ({ source: "dispatch" as const, dispatch })),
          ].sort((left, right) => {
            const leftAt = recordedAt(left);
            const rightAt = recordedAt(right);
            if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
            if (left.source !== right.source) return left.source === "journal" ? -1 : 1;
            return 0;
          });
          const workspace = await readManagedWorktreeAppointment(this.scope, this.id);
          return {
            id: this.id,
            state: mintSnapshotId(commit),
            ...(workspace.kind === "appointed"
              ? { workspace: { kind: "worktree" as const, path: workspace.path } }
              : {}),
            events,
          };
        }),
      ),
    );
  }

  async guidance(): Promise<string | null> {
    return await this.read(() =>
      withGitDecodeChannel(this.scope, async (channel) => {
        const observed = await contractObservationOperation({ scope: this.scope, channel, contractId: this.id });
        if (observed.kind === "missing") return null;
        const state = await stateOperation({ scope: this.scope, channel, contractId: this.id });
        return state === null ? null : renderContractGuidance(state);
      }),
    );
  }

  async delivery(): Promise<Delivery | null> {
    const delivery = await this.read(() =>
      withGitDecodeChannel(this.scope, (channel) =>
        deliveryOperation({ scope: this.scope, channel, contractId: this.id }),
      ),
    );
    return delivery === null ? null : deliveryForContract(this.scope, delivery);
  }

  async amend(input: AmendInput): Promise<AmendOutcome> {
    return await this.operations.amend(input);
  }

  async deliver(input?: DeliverInput, options?: MutationObservation): Promise<DeliverOutcome> {
    return await this.operations.deliver(input, options);
  }

  async review(input: ReviewInput, options?: MutationObservation): Promise<ReviewOutcome> {
    return await this.operations.review(input, options);
  }

  async abandon(input?: AbandonInput): Promise<AbandonOutcome> {
    return await this.operations.abandon(input);
  }

  async arc(input: ArcInput): Promise<ArcOutcome> {
    return await this.operations.arc(input);
  }

  async audit(input?: AuditInput, options?: MutationObservation): Promise<AuditOutcome> {
    return await this.operations.audit(input, options);
  }

  /**
   * Reads answer with a value or `null` for legitimate absence. Corrupt authority stays exceptional
   * and keeps its original native cause instead of being disguised as a raw native exception.
   */
  private async read<Value>(operation: () => Promise<Value>): Promise<Value> {
    return await readContractValue(operation);
  }
}
/** Internal constructor capability; callers select a Contract through Keiyaku.with. */
export function createKeiyakuHandle(
  id: ContractId,
  scope: RepositoryScope,
  execution: ExecutionContext,
  composition: LocalContractCompositionCapture,
): Keiyaku {
  return new Keiyaku(KEIYAKU_HANDLE, id, scope, execution, composition);
}

/** Internal package composition capability; not exported from the package root. */
export function seatForKeiyaku(value: unknown): HandleSeat | null {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? (KEIYAKU_SEATS.get(value) ?? null)
    : null;
}
