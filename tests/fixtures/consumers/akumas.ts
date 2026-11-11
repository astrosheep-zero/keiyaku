import {
  Akuma,
  AkumaArchetypeError,
  AkumaHost,
  Akumas,
  Keis,
  actorId,
  akumaStatusSchema,
  akumaCatalogueSchema,
  listArchetypeDefinitions,
  nuke,
  type AkumaId,
  type AkumaAliasesInput,
  type AkumaListInput,
  type AkumaList,
  type AliasBinding,
  type AkumaHostOptions,
  type AkumaHostScope,
  type ArchetypeCatalog,
  type ArchetypeCatalogInput,
  type ArchetypeCatalogRow,
  type KeisOptions,
  type Repo,
  type WorldRoot,
} from "@astrosheep/keiyaku";

declare const world: WorldRoot;
declare const aku: AkumaId;
declare const repo: Repo;
declare const nativeError: unknown;

const catalogueInput: ArchetypeCatalogInput = { project: world, home: "/tmp/keiyaku-consumer-home", limit: 25 };
const catalogue: Promise<ArchetypeCatalog> = listArchetypeDefinitions(catalogueInput);
const catalogueRows: readonly ArchetypeCatalogRow[] = [];
if (nativeError instanceof AkumaArchetypeError) {
  const kind: "akuma-archetype" = nativeError.kind;
  const searched: readonly string[] = nativeError.searched;
  void [kind, searched];
}
void [catalogue, catalogueRows];

const contractPolicy: KeisOptions = { actor: actorId("contract-owner") };
Keis.of(repo, contractPolicy);

const scope: AkumaHostScope = AkumaHost.inProcess({ reportDiagnostic: console.error });
const scoped = Akumas.of(world, scope);
const scopedSingle = Akuma.select(world, aku, scope);
const closed: Promise<void> = scope.close();
void [scoped, scopedSingle, closed];

const host: AkumaHostOptions = { reportDiagnostic: (message) => console.error(message) };
const plural = Akumas.of(world, host);
const rosterInput: AkumaListInput = { limit: 25, repo };
const roster: Promise<AkumaList> = plural.list(rosterInput);
const row = akumaCatalogueSchema.parse(await roster).rows?.[0];
const parent: AkumaId | undefined = row?.parentAkumaId;
void parent;
const aliasInput: AkumaAliasesInput = { akumaIds: [aku, "aku/worker/1234abcd"] };
const aliases: Promise<readonly AliasBinding[]> = plural.aliases(aliasInput);
void aliases;
const status = plural.status({ akuma: aku });
const single = Akuma.select(world, aku, host);
const singleStatus = await single.status();
const entry = singleStatus.work.summary;
if (entry !== undefined) {
  // @ts-expect-error public current-work summaries retain the owner's readonly projection
  entry.text = "changed";
}
const wireEntry = akumaStatusSchema.parse(singleStatus).work.summary;
if (wireEntry !== undefined) {
  // @ts-expect-error parsed public current-work summaries remain readonly
  wireEntry.text = "changed";
}
const constructor: Function = Akuma;
const prototype: Akuma = Akuma.prototype;
if (nativeError instanceof Akuma) {
  const narrowed: Akuma = nativeError;
  void narrowed.id;
}
// @ts-expect-error the public class keeps its private construction boundary
new Akuma(aku, world, console.error);
void [constructor, prototype];
const born = Akuma.birth("worker", { root: world, host });
const reset = nuke({ world, confirm: world });

void roster;
void status;
void single;
void born;
// @ts-expect-error host options are immutable
host.reportDiagnostic = () => {};
// @ts-expect-error diagnostics are a host capability, not an operation input
plural.status({ akuma: aku, reportDiagnostic: () => {} });
// @ts-expect-error diagnostic callback must be callable
Akuma.select(world, aku, { reportDiagnostic: "stderr" });
void reset;

// @ts-expect-error Akumas captures World instead of accepting it per operation
plural.status({ path: world, akuma: aku });
// @ts-expect-error Repo is not inferred from World
plural.status({ akuma: aku, repo: world });
// @ts-expect-error Repo cannot be substituted for the captured World
Akumas.of(repo);
// @ts-expect-error Contract-local policy cannot configure plural Akuma composition
Akumas.of(world, contractPolicy);
// @ts-expect-error the removed execution carrier is not a public input
Akumas.of(world, { execution: {} });
// @ts-expect-error Keis exposes no Akuma creation operation
Keis.of(repo).spawn({ akumaName: "worker", body: "not a Contract" });
// @ts-expect-error selection uses the Contract owner's `kei` verb
Keis.of(repo).of({ id: "kei/example" as never });
// @ts-expect-error old execution constructors are removed
Keis.withExecution({ execution: {} });
// @ts-expect-error the old mixed package-root catalog spelling is removed
Keis.of(repo).ls({ query: { kind: "akuma" } });
// @ts-expect-error Debt operations do not enter the World-bound Akumas surface
plural.debt({ id: "debt/not-an-akuma" });
// @ts-expect-error Contract collection requires a Repo coordinate
Keis.of(world);
// @ts-expect-error nuke is a root operation, not a Keiyaku method
Akuma.nuke({ world, confirm: world });
// @ts-expect-error the retired ./akumas subpath promise is gone
type RemovedAkumasSubpath = import("@astrosheep/keiyaku/akumas").Akumas;
// @ts-expect-error the private Archetype loader stays off the package root
type RemovedArchetypeLoader = import("@astrosheep/keiyaku").loadArchetype;
