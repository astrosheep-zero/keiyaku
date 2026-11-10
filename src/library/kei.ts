/** @architectureCompositionRoot */
import { z } from "zod";
import { renderContractGuidance } from "../contract-guidance.js";
import type { ContractId, ContractState, ContractTerms, JournalEntry } from "../core/facts/types.js";
import { parseToAST } from "../markdown/parse.js";
import { indexDocument, indexedHeadings, sectionContent } from "../markdown/query.js";
import { readDispatchesAt } from "../dispatch/index.js";
import { observeContractsForAdmissionInObservationAt } from "../git/observe.js";
import { withGitDecodeChannel, withGitReadObservation } from "../git/read-observation.js";
import {
  contractObservationOperation,
  deliveryOperation,
  stateOperation,
  type RepositoryScope,
} from "../protocol/operations.js";
import { errorCategory, readContractValue, validated } from "./outcome.js";
import { optionalBoolean, requireInput } from "./input.js";
import { ContractExecution } from "./contract-execution.js";
import type {
  AbandonOutcome,
  AmendOutcome,
  ArcOutcome,
  DeliveryPreviewInput,
  DeliveryPreviewOutcome,
  DeliverOutcome,
  MutationObservation,
  ReviewOutcome,
  VerifyOutcome,
} from "./contract-outcomes.js";
import type { LocalContractCompositionCapture } from "./contract-settings.js";
import type {
  AbandonInput,
  AmendInput,
  ArcInput,
  ContractHistory,
  ContractHistoryInput,
  ContractHistoryEvent,
  DeliverInput,
  ReviewInput,
  VerifyInput,
} from "./contract-types.js";
import { compactDelivery, type Delivery } from "./delivery.js";
import {
  validateContractWaitHandle,
  waitContractLocal,
  type ContractWaitOptions,
  type ContractWaitResult,
} from "./contract-wait.js";

export const guidanceSchema = z.union([
  z.strictObject({ kind: z.literal("present"), guidance: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("missing") }).readonly(),
]);
export type Guidance = z.output<typeof guidanceSchema>;

const KEIYAKU_HANDLE = Symbol("Kei handle");

type HandleSeat = Readonly<{ id: ContractId; scope: RepositoryScope }>;
const KEIYAKU_SEATS = new WeakMap<object, HandleSeat>();

export class Kei {
  private readonly id: ContractId;
  private readonly scope: RepositoryScope;
  private readonly operations: ContractExecution;

  constructor(
    token: typeof KEIYAKU_HANDLE,
    id: ContractId,
    scope: RepositoryScope,
    composition: LocalContractCompositionCapture,
  ) {
    if (token !== KEIYAKU_HANDLE) throw new TypeError("Kei handles are created by Keis.of");
    this.id = id;
    this.scope = scope;
    this.operations = new ContractExecution({ id, scope, composition });
    // Process-local custody never serializes: identity-only JSON projection.
    Object.defineProperties(this, {
      id: { value: id, enumerable: false },
      scope: { value: scope, enumerable: false },
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
    return await readContractValue(() =>
      withGitDecodeChannel(this.scope, (channel) =>
        stateOperation({ scope: this.scope, channel, contractId: this.id }),
      ),
    );
  }

  async wait(input?: ContractWaitOptions): Promise<ContractWaitResult> {
    return await waitContractLocal(validateContractWaitHandle(this.scope, this.id, input));
  }

  async history(input?: ContractHistoryInput): Promise<ContractHistory> {
    const full = validated(() => {
      const values = input === undefined ? {} : requireInput(input, "Contract history input", ["full"]);
      return optionalBoolean(values.full, "full") === true;
    });
    return await readContractValue(() =>
      withGitDecodeChannel(this.scope, (channel) =>
        withGitReadObservation(this.scope, channel, async (observation) => {
          const journals = await observeContractsForAdmissionInObservationAt(observation, [this.id]);
          const record = journals.journals.get(this.id);
          if (record === undefined) throw new Error(`missing requested contract observation: ${this.id}`);
          if (record.state === null) return { kind: "contract-missing", contractId: this.id };
          let terms: ContractTerms | undefined;
          const events: ContractHistoryEvent[] = record.entries.map((entry) => {
            const event = historyEvent(entry, terms, full);
            if (entry.kind === "bind") terms = entry.data.terms;
            else if (entry.kind === "amend") terms = entry.data;
            return event;
          });
          let unavailable: Extract<ContractHistory, { kind: "contract" }>["dispatches"];
          let dispatches;
          try {
            dispatches = await readDispatchesAt(observation);
          } catch (error) {
            const category = errorCategory(error);
            if (category === "aborted" || this.scope.signal?.aborted === true) throw error;
            unavailable = {
              kind: "unavailable",
              category: category === "authority-corruption" ? category : "internal",
              diagnostic: error instanceof Error ? error.message : String(error),
            };
          }
          events.push(
            ...(dispatches ?? [])
              .filter((dispatch) => dispatch.contractId === this.id)
              .map((dispatch) => ({
                kind: "dispatch" as const,
                at: dispatch.dispatchedAt,
                akumaId: dispatch.akumaId,
              })),
          );
          events.sort((left, right) => {
            if (left.at !== right.at) return left.at < right.at ? -1 : 1;
            if ((left.kind === "dispatch") !== (right.kind === "dispatch")) return left.kind === "dispatch" ? 1 : -1;
            return 0;
          });
          return {
            kind: "contract",
            contractId: this.id,
            events,
            ...(unavailable === undefined ? {} : { dispatches: unavailable }),
          };
        }),
      ),
    );
  }

  async guidance(): Promise<Guidance> {
    return await readContractValue(() =>
      withGitDecodeChannel(this.scope, async (channel) => {
        const observed = await contractObservationOperation({ scope: this.scope, channel, contractId: this.id });
        if (observed.kind === "missing") return { kind: "missing" };
        const state = await stateOperation({ scope: this.scope, channel, contractId: this.id });
        return state === null ? { kind: "missing" } : { kind: "present", guidance: renderContractGuidance(state) };
      }),
    );
  }

  async delivery(): Promise<Delivery | null> {
    const delivery = await readContractValue(() =>
      withGitDecodeChannel(this.scope, (channel) =>
        deliveryOperation({ scope: this.scope, channel, contractId: this.id }),
      ),
    );
    return delivery === null ? null : compactDelivery(delivery);
  }

  async amend(input: AmendInput): Promise<AmendOutcome> {
    return await this.operations.amend(input);
  }

  async deliver(input?: DeliverInput, options?: MutationObservation): Promise<DeliverOutcome> {
    return await this.operations.deliver(input, options);
  }

  async verify(input?: VerifyInput, options?: MutationObservation): Promise<VerifyOutcome> {
    return await this.operations.verify(input, options);
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

  async previewDelivery(input?: DeliveryPreviewInput, options?: MutationObservation): Promise<DeliveryPreviewOutcome> {
    return await this.operations.previewDelivery(input, options);
  }
}

function changedHistoryTerms(before: ContractTerms | undefined, after: ContractTerms) {
  const sections = (terms: ContractTerms): ReadonlyMap<string, string> => {
    const document = parseToAST(terms.document.bytes);
    return new Map(
      indexedHeadings(indexDocument(document), { level: 2 })
        .filter((section) => section.type === "section")
        .map((section) => [section.title, sectionContent(document, section)]),
    );
  };
  const source = before === undefined ? new Map<string, string>() : sections(before);
  const amended = sections(after);
  const changedSections = [...new Set([...source.keys(), ...amended.keys()])].filter(
    (name) => source.get(name) !== amended.get(name),
  );
  const equal = (left: readonly string[] | undefined, right: readonly string[]): boolean =>
    left !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);
  return {
    ...(changedSections.length === 0 ? {} : { changedSections }),
    ...(equal(before?.gates, after.gates) ? {} : { gates: after.gates }),
    ...(equal(before?.after, after.after) ? {} : { after: after.after }),
  };
}

function attestationHistory(entry: Extract<JournalEntry, { kind: "attestation" }>) {
  const { gate, requirement, subject, verdict, summary } = entry.data;
  return {
    kind: "attestation" as const,
    gate,
    requirement,
    verdict,
    subject,
    ...(summary === undefined ? {} : { summary }),
  };
}

function historyEvent(entry: JournalEntry, terms: ContractTerms | undefined, full: boolean): ContractHistoryEvent {
  const common = { id: entry.entry, at: entry.at, ...(entry.actor === undefined ? {} : { actor: entry.actor }) };
  switch (entry.kind) {
    case "bind": {
      const { coordinates, terms: bound } = entry.data;
      const target = coordinates.target;
      return {
        ...common,
        kind: "bind",
        start: coordinates.start,
        ...(target === undefined
          ? {}
          : {
              target:
                typeof target === "string" ? target : { kind: "contract" as const, contractId: target.contractId },
            }),
        ...(full
          ? {
              document: bound.document.bytes,
              gates: bound.gates,
              after: bound.after,
              ...(typeof target === "object" ? { targetIncarnation: target.worktree } : {}),
            }
          : {
              ...(bound.gates.length === 0 ? {} : { gates: bound.gates }),
              ...(bound.after.length === 0 ? {} : { after: bound.after }),
            }),
      };
    }
    case "amend":
      return {
        ...common,
        kind: "amend",
        ...changedHistoryTerms(terms, entry.data),
        ...(full ? { document: entry.data.document.bytes, gates: entry.data.gates, after: entry.data.after } : {}),
      };
    case "deliver": {
      const { tenderSnapshot, integration, note } = entry.data;
      return {
        ...common,
        kind: "deliver",
        candidate: tenderSnapshot,
        integration: integration.snapshot,
        contentId: integration.changeId,
        predecessor: integration.predecessor,
        ...(note === undefined ? {} : { note }),
        ...(full ? { requireBranchesToBeUpToDate: entry.data.policy.requireBranchesToBeUpToDate } : {}),
      };
    }
    case "reintegrated":
      return {
        ...common,
        kind: "reintegrated",
        predecessor: entry.data.predecessor,
        integration: entry.data.snapshot,
      };
    case "attestation":
      return { ...common, ...attestationHistory(entry) };
    case "claimed":
      return { ...common, kind: "claimed", deliveryId: entry.data.delivery };
    case "arc":
      return {
        ...common,
        kind: "arc",
        chapter: entry.data.seq,
        title: entry.data.title,
        ...(entry.data.body.length === 0 && !full ? {} : { body: entry.data.body }),
      };
    case "abandoned":
      return {
        ...common,
        kind: "abandoned",
        ...(entry.data.note === undefined ? {} : { note: entry.data.note }),
      };
  }
}

/** Internal constructor capability; callers select a Contract through Keis.of. */
export function createKeiHandle(
  id: ContractId,
  scope: RepositoryScope,
  composition: LocalContractCompositionCapture,
): Kei {
  return new Kei(KEIYAKU_HANDLE, id, scope, composition);
}

/** Internal package composition capability; not exported from the package root. */
export function seatForKei(value: unknown): HandleSeat | null {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? (KEIYAKU_SEATS.get(value) ?? null)
    : null;
}
