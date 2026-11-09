type CommandRepoPolicy = Readonly<{ use: "none" | "optional" | "required"; acceptsExplicit: boolean }>;

type SemanticCommand =
  | Readonly<{
      command: "bind" | "amend" | "deliver" | "verify" | "review" | "arc" | "abandon" | "reconcile" | "region" | "show";
    }>
  | Readonly<{ command: "ls"; query: Readonly<{ kind: string }> }>
  | Readonly<{ command: "status" | "whoami" | "tell" | "ask" | "fork" }>
  | Readonly<{ command: "history"; contract?: string }>
  | Readonly<{ command: "wait" | "kill"; akuma: readonly string[] }>
  | Readonly<{ command: "spawn"; contract?: string }>
  | Readonly<{ command: "report" | "settings" | "nuke" | "debt" | "install" }>;

export function commandRepoPolicy(command: SemanticCommand): CommandRepoPolicy {
  switch (command.command) {
    case "bind":
    case "amend":
    case "deliver":
    case "verify":
    case "review":
    case "arc":
    case "abandon":
    case "reconcile":
    case "region":
    case "show":
      return { use: "required", acceptsExplicit: true };
    case "ls":
      return { use: command.query.kind === "contracts" ? "required" : "none", acceptsExplicit: false };
    case "status":
    case "whoami":
    case "tell":
    case "ask":
      return { use: "optional", acceptsExplicit: false };
    case "history":
      return "contract" in command
        ? { use: "required", acceptsExplicit: true }
        : { use: "optional", acceptsExplicit: false };
    case "fork":
      return { use: "optional", acceptsExplicit: true };
    case "wait":
    case "kill": {
      const contractSelector = command.akuma.some((selector) => selector.startsWith("kei/"));
      return { use: contractSelector ? "required" : "optional", acceptsExplicit: contractSelector };
    }
    case "spawn":
      return {
        use: command.contract === undefined ? "none" : "required",
        acceptsExplicit: command.contract !== undefined,
      };
    case "report":
    case "settings":
    case "nuke":
    case "debt":
    case "install":
      return { use: "none", acceptsExplicit: false };
  }
}
