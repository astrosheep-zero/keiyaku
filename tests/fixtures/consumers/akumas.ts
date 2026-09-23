import { Akuma, Akumas, bodyRequestExecution, nuke, type AkuId, type WorldRoot } from "@astrosheep/keiyaku";
import { Keiyaku, type LocalContractComposition, type Repo } from "@astrosheep/keiyaku";
import { Akumas as AkumasSubpath } from "@astrosheep/keiyaku/akumas";

declare const world: WorldRoot;
declare const aku: AkuId;
declare const repo: Repo;

const contractPolicy: LocalContractComposition = {
  actor: "contract-owner",
  hooks: { create: [], destroy: [] },
  requireBranchesToBeUpToDate: true,
};
Keiyaku.with(contractPolicy);

const plural = Akumas.of(world);
const pluralSubpath = AkumasSubpath.of(world);
const routed = Akumas.of(world, { execution: bodyRequestExecution({ directory: "/tmp/requests" }) });
const roster = plural.list({ limit: 25 });
const status = routed.status({ akuma: aku });
const single = Akuma.select(world, aku);
const reset = nuke({ world, confirm: world });

void roster;
void pluralSubpath;
void status;
void single;
void reset;

// @ts-expect-error Akumas captures World instead of accepting it per operation
plural.status({ path: world, akuma: aku });
// @ts-expect-error Repo is not inferred from World
plural.status({ akuma: aku, repo: world });
// @ts-expect-error Repo cannot be substituted for the captured World
Akumas.of(repo);
// @ts-expect-error Contract-local policy cannot configure plural Akuma composition
Akumas.of(world, contractPolicy);
// @ts-expect-error Keiyaku.with exposes no Akuma creation operation
Keiyaku.with().call({ archetype: "worker", body: "not a Contract" });
// @ts-expect-error selection uses the Contract owner's `select` verb
Keiyaku.with().of({ repo, id: "kei/example" as never });
// @ts-expect-error old execution constructors are removed
Keiyaku.withExecution({ execution: bodyRequestExecution({ directory: "/tmp/requests" }) });
// @ts-expect-error the old mixed package-root catalog spelling is removed
Keiyaku.with().ls({ query: { kind: "akuma" } });
// @ts-expect-error Task operations belong to the Task product subpath
Keiyaku.with().task({ id: "task/not-a-contract" });
// @ts-expect-error Task operations do not enter the World-bound Akumas surface
plural.task({ id: "task/not-an-akuma" });
// @ts-expect-error Contract selection retains an explicit Repo coordinate
Keiyaku.with().select({ id: "kei/example" });
// @ts-expect-error nuke is a root operation, not a Keiyaku method
Akuma.nuke({ world, confirm: world });
