import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  prepareFileInputs,
  applyClientFileDirectives,
  CLIENT_FILE_MARKER,
  type FileInputSpec,
  type FileInputWire,
} from "../src/file-inputs.js";
import { createToolsClient, type ToolMeta } from "../src/tools-client.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "client-e2e-dirs-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const e2e = (name: string) => path.join(root, ".argent", "e2e", name);
const legacy = (name: string) => path.join(root, ".argent", "flows", name);

async function write(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "steps: []\n");
}

/** flow-execute's flow_file spec, as a tool-server with both directories advertises it. */
const flowFileSpec: FileInputSpec = {
  target: "flow_file",
  path: "${project_root}/.argent/flows/${name}.yaml",
  paths: ["${project_root}/.argent/e2e/${name}.yaml", "${project_root}/.argent/flows/${name}.yaml"],
  kind: "file",
  skipWhenSet: "flow_path",
};

async function derived(name: string, spec = flowFileSpec): Promise<string> {
  const out = (await prepareFileInputs(
    [spec],
    { name, project_root: root },
    {
      includeContent: false,
    }
  )) as Record<string, FileInputWire>;
  return out.flow_file!.path;
}

describe("a flow_file derived from paths", () => {
  it("is the .argent/e2e test when there is one, also beside a same-named legacy test", async () => {
    await write(e2e("both.yaml"));
    await write(legacy("both.yaml"));
    await write(e2e("new.yaml"));

    expect(await derived("both")).toBe(e2e("both.yaml"));
    expect(await derived("new")).toBe(e2e("new.yaml"));
  });

  it("is the .argent/flows test when only it exists", async () => {
    await write(legacy("old.yaml"));

    expect(await derived("old")).toBe(legacy("old.yaml"));
  });

  it("is the .argent/e2e path when neither exists", async () => {
    expect(await derived("nowhere")).toBe(e2e("nowhere.yaml"));
  });

  it("is `path` for a tool-server that advertises no paths", async () => {
    await write(e2e("new.yaml"));
    const { paths: _paths, ...older } = flowFileSpec;

    expect(await derived("new", older)).toBe(legacy("new.yaml"));
  });
});

describe("a recorded test written by the client", () => {
  it.each(["e2e", "flows"])("is written into .argent/%s", async (dir) => {
    const file = path.join(root, ".argent", dir, "rec.yaml");
    const { result, written } = await applyClientFileDirectives({
      savedTo: { [CLIENT_FILE_MARKER]: true, path: file, content: "steps: []\n" },
    });

    expect(result).toEqual({ savedTo: file });
    expect(written).toEqual([file]);
    await expect(fs.readFile(file, "utf8")).resolves.toBe("steps: []\n");
  });

  it("is refused in any other directory under .argent", async () => {
    const file = path.join(root, ".argent", "tests", "rec.yaml");
    const { result, written } = await applyClientFileDirectives({
      savedTo: { [CLIENT_FILE_MARKER]: true, path: file, content: "steps: []\n" },
    });

    expect(result).toEqual({ savedTo: null });
    expect(written).toEqual([]);
  });
});

/** A `GET /tools` listing and the POSTs a client sent to it. */
function stubServer(tools: ToolMeta[], remote = false) {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const diagnostics: string[] = [];
  const client = createToolsClient({
    baseUrl: async () => ({ url: "http://stub", token: "t", remote }),
    onDiagnostic: (line) => diagnostics.push(line),
    fetchImpl: async (url, init) => {
      if (url.endsWith("/tools")) return Response.json({ tools });
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ data: { ok: true } });
    },
  });
  return { client, posts, diagnostics };
}

const { paths: _paths, ...olderFlowFileSpec } = flowFileSpec;
// The tool-server lists `unwrapWhenSet`; the client's spec type leaves it out.
const flowPathSpec: FileInputSpec & { unwrapWhenSet: string } = {
  target: "flow_path",
  path: "${flow_path}",
  kind: "file",
  optional: true,
  unwrapWhenSet: "name",
};

/** The flow-* tools as a 0.29.0 tool-server lists them: no e2e-* ids, no `paths`. */
const olderTools: ToolMeta[] = ["flow-execute", "flow-read-prerequisite"].map((name) => ({
  name,
  description: "",
  inputSchema: {},
  fileInputs: [flowPathSpec, olderFlowFileSpec],
}));

/** The same tools as this tool-server lists them: e2e-* ids with `paths`, flow-* as aliases. */
const newerTools: ToolMeta[] = ["execute", "read-prerequisite"].flatMap((tool) => {
  const entry = {
    name: `e2e-${tool}`,
    description: "",
    inputSchema: {},
    fileInputs: [flowPathSpec, flowFileSpec],
  };
  return [entry, { ...entry, name: `flow-${tool}`, hideFromMcp: true, aliasOf: entry.name }];
});

/** The path a wire value names: a wrapped file input, or the plain string. */
function named(value: unknown): unknown {
  return typeof value === "object" && value !== null ? (value as FileInputWire).path : value;
}

describe("a call by name to a tool-server that predates .argent/e2e", () => {
  it.each(["e2e-execute", "e2e-read-prerequisite"])("finds %s under its former id", async (id) => {
    const { client, posts } = stubServer(olderTools);
    const legacyId = id.replace("e2e-", "flow-");

    expect((await client.fetchTool(id))?.name).toBe(legacyId);
    await client.callTool(id, { name: "nowhere", project_root: root });
    expect(posts[0]!.url).toBe(`http://stub/tools/${legacyId}`);
  });

  it.each([false, true])(
    "names a test only in .argent/e2e by flow_path (remote: %s)",
    async (remote) => {
      await write(e2e("new.yaml"));
      const { client, posts } = stubServer(olderTools, remote);

      await client.callTool("e2e-execute", { name: "new", project_root: root });
      expect(posts[0]!.body.name).toBeUndefined();
      expect(named(posts[0]!.body.flow_path)).toBe(e2e("new.yaml"));
    }
  );

  it("names the .argent/e2e test when both directories hold the name, and says so", async () => {
    await write(e2e("both.yaml"));
    await write(legacy("both.yaml"));
    const { client, posts, diagnostics } = stubServer(olderTools);

    await client.callTool("flow-execute", { name: "both", project_root: root });
    expect(posts[0]!.url).toBe("http://stub/tools/flow-execute");
    expect(named(posts[0]!.body.flow_path)).toBe(e2e("both.yaml"));
    expect(diagnostics.some((line) => line.includes(legacy("both.yaml")))).toBe(true);
  });

  it.each([
    ["only in .argent/flows", "old"],
    ["nowhere", "nowhere"],
  ])("keeps the name for a test %s", async (_where, name) => {
    await write(legacy("old.yaml"));
    const { client, posts } = stubServer(olderTools);

    await client.callTool("e2e-read-prerequisite", { name, project_root: root });
    expect(posts[0]!.body.name).toBe(name);
    expect(posts[0]!.body.flow_path).toBeUndefined();
    expect(named(posts[0]!.body.flow_file)).toBe(legacy(`${name}.yaml`));
  });
});

describe("a call by name to a tool-server that lists both ids", () => {
  it("keeps the id it was called by and the name", async () => {
    await write(e2e("new.yaml"));
    const { client, posts } = stubServer(newerTools);

    await client.callTool("flow-execute", { name: "new", project_root: root });
    expect(posts[0]!.url).toBe("http://stub/tools/flow-execute");
    expect(posts[0]!.body.name).toBe("new");
    expect(named(posts[0]!.body.flow_file)).toBe(e2e("new.yaml"));
    expect((await client.fetchTool("e2e-execute"))?.name).toBe("e2e-execute");
  });
});
