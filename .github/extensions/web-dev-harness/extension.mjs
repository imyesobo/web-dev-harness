import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";

const webDevHarness = defineWorkflow({
  meta: {
    name: "web-dev-harness",
    description:
      "Create a test-driven Open-WC implementation from work-item, design, and API context.",
    phases: [{ title: "Specification" }, { title: "Implementation" }],
    argsSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string" },
        workItem: { type: "string" },
        design: { type: "string" },
        apiContract: { type: "string" },
      },
    },
    limits: {
      maxConcurrentSubagents: 1,
      timeoutSeconds: 1800,
    },
  },

  run: async (ctx) => {
    const context = [
      `Task:\n${ctx.args.task}`,
      ctx.args.workItem && `Work item:\n${ctx.args.workItem}`,
      ctx.args.design && `Design:\n${ctx.args.design}`,
      ctx.args.apiContract && `API contract:\n${ctx.args.apiContract}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    ctx.phase("Specification");
    const specification = await ctx.step("web-dev-harness-spec-v1", () =>
      ctx.agent(
        [
          "Create a concrete test-driven implementation specification for this web-component task.",
          "Use Lit, Open-WC, and @lion/ui conventions. Map controls to appropriate Lion primitives.",
          "Specify the component structure and contract, Storybook, Playwright, and accessibility tests.",
          "Use only the supplied context; identify missing information instead of inventing requirements.",
          "Do not edit files or claim that tests have run.",
          context,
        ].join("\n\n"),
        { label: "Write implementation specification" },
      ),
    );
    if (specification === null) {
      throw new Error("Copilot could not produce the implementation specification");
    }

    ctx.phase("Implementation");
    const implementation = await ctx.step("web-dev-harness-implementation-v1", () =>
      ctx.agent(
        [
          "Implement the approved specification in the current workspace.",
          "Use Lit and @lion/ui, preserve existing project conventions, and add focused tests.",
          "Do not publish changes, create pull requests, deploy, or claim verification passed.",
          `Approved specification:\n${specification}`,
          context,
        ].join("\n\n"),
        { label: "Implement web component" },
      ),
    );
    if (implementation === null) {
      throw new Error("Copilot could not complete the implementation");
    }

    return { specification, implementation };
  },
});

await joinSession({ workflows: [webDevHarness] });
