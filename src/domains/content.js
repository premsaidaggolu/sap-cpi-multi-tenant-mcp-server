// Design-time content domain: packages, integration flows, mappings, script
// collections, configurations, resources.
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { cpiGet, cpiRequest, cpiInvoke, odataString } from "../cpiClient.js";
import { readHandler, writeHandler, registerScopedTool } from "./helpers.js";
import { sanitizeTechnicalId } from "../iflow/xml.js";

export function registerContentTools(server) {
  // --- Packages -----------------------------------------------------------
  registerScopedTool(server,
    "list_integration_packages",
    {
      title: "List Integration Packages",
      description: "List all integration packages in the tenant's design workspace.",
      inputSchema: { top: z.number().int().min(1).max(500).default(100) },
    },
    readHandler(({ top }) => cpiGet("/IntegrationPackages", { $top: top }))
  );

  registerScopedTool(server,
    "get_integration_package",
    {
      title: "Get Integration Package",
      description: "Get details of a single integration package by Id.",
      inputSchema: { packageId: z.string() },
    },
    readHandler(({ packageId }) => cpiGet(`/IntegrationPackages(${odataString(packageId)})`))
  );

  registerScopedTool(server,
    "create_integration_package",
    {
      title: "Create Integration Package",
      description:
        "Create a new integration package. Requires ALLOW_WRITE. The technical Id is auto-sanitized (CPI " +
        "rejects underscores/spaces/special characters in it with 'Property 'Id' value cannot have a special " +
        "character') — the original text is kept as the display Name/ShortText, unaffected.",
      inputSchema: {
        id: z.string().describe("Technical Id — non-alphanumeric characters are stripped automatically."),
        name: z.string(),
        shortText: z.string().optional(),
        description: z.string().optional(),
        confirm: z.boolean().optional().describe("Must be true to proceed."),
      },
    },
    writeHandler(
      async ({ id, name, shortText, description }) => {
        const sanitizedId = sanitizeTechnicalId(id);
        const result = await cpiRequest("POST", "/IntegrationPackages", {
          body: { Id: sanitizedId, Name: name, ShortText: shortText || name, Description: description || "" },
        });
        if (sanitizedId === id) return result;
        return {
          ...result,
          id: sanitizedId,
          note: `Id "${id}" contained characters CPI rejects — created as "${sanitizedId}" instead. Name/ShortText keep your original text.`,
        };
      },
      { action: ({ id }) => `create integration package '${sanitizeTechnicalId(id)}'` }
    )
  );

  registerScopedTool(server,
    "delete_integration_package",
    {
      title: "Delete Integration Package",
      description:
        "Delete an integration package and all its artifacts. Requires ALLOW_WRITE and confirm=true.",
      inputSchema: { packageId: z.string(), confirm: z.boolean().optional() },
    },
    writeHandler(({ packageId }) => cpiRequest("DELETE", `/IntegrationPackages(${odataString(packageId)})`), {
      destructive: ({ packageId }) => `delete package '${packageId}' and everything in it`,
    })
  );

  registerScopedTool(server,
    "copy_integration_package",
    {
      title: "Copy Integration Package (from Hub / Discover)",
      description:
        "Copy a standard/partner package (e.g. from the Discover catalog) into the design workspace. " +
        "Requires ALLOW_WRITE.",
      inputSchema: {
        packageId: z.string().describe("Id of the package to copy."),
        confirm: z.boolean().optional().describe("Must be true to proceed."),
      },
    },
    writeHandler(({ packageId }) => cpiInvoke("CopyIntegrationPackage", { Id: packageId }), {
      action: ({ packageId }) => `copy package '${packageId}' into the design workspace`,
    })
  );

  // --- Integration flows (design-time artifacts) --------------------------
  registerScopedTool(server,
    "list_integration_flows",
    {
      title: "List Integration Flows in a Package",
      description: "List the integration flow design-time artifacts in a package.",
      inputSchema: { packageId: z.string() },
    },
    readHandler(({ packageId }) =>
      cpiGet(`/IntegrationPackages(${odataString(packageId)})/IntegrationDesigntimeArtifacts`)
    )
  );

  registerScopedTool(server,
    "get_integration_flow",
    {
      title: "Get Integration Flow Details",
      description: "Get a design-time integration flow artifact by Id and Version.",
      inputSchema: {
        artifactId: z.string(),
        version: z.string().default("active"),
      },
    },
    readHandler(({ artifactId, version }) =>
      cpiGet(
        `/IntegrationDesigntimeArtifacts(Id=${odataString(artifactId)},Version=${odataString(version)})`
      )
    )
  );

  registerScopedTool(server,
    "download_integration_flow",
    {
      title: "Download Integration Flow (base64 zip)",
      description:
        "Download the integration flow content as a base64-encoded zip ($value). Useful for backup/transport.",
      inputSchema: { artifactId: z.string(), version: z.string().default("active") },
    },
    readHandler(async ({ artifactId, version }) => {
      const buf = await cpiGet(
        `/IntegrationDesigntimeArtifacts(Id=${odataString(artifactId)},Version=${odataString(version)})/$value`,
        {},
        { binary: true }
      );
      return {
        artifactId,
        version,
        encoding: "base64",
        contentLength: buf.length,
        content: buf.toString("base64"),
      };
    })
  );

  registerScopedTool(server,
    "push_integration_flow_content",
    {
      title: "Push Raw Integration Flow Content (zip)",
      description:
        "Overwrite an EXISTING integration flow's content with a raw zip you already have — e.g. one downloaded " +
        "via download_integration_flow and hand-edited locally, or one build_integration_flow generated in " +
        "offline mode (its zipFilePath — an online build never leaves a local file, since the content is already " +
        "on the tenant). Just replaces ArtifactContent as-is; doesn't touch the manifest/shell, and doesn't create " +
        "the artifact if it doesn't exist yet (use create_integration_flow or build_integration_flow for that). " +
        "Requires ALLOW_WRITE.",
      inputSchema: {
        artifactId: z.string(),
        version: z.string().default("active"),
        name: z.string().optional().describe("Display name to set alongside the content. Omit to keep the artifact's current Name (fetched automatically)."),
        zipFilePath: z
          .string()
          .optional()
          .describe(
            "Absolute path to a zip file already on THIS SERVER's filesystem (e.g. an offline " +
              "build_integration_flow's zipFilePath). Preferred over zipBase64 — reads the bytes directly server-" +
              "side instead of round-tripping a large base64 blob through the caller, which is itself a real " +
              "corruption risk for anything past a few KB. Exactly one of zipFilePath/zipBase64 is required."
          ),
        zipBase64: z.string().optional().describe("Base64-encoded zip content, for when the caller only has it in memory. Exactly one of zipFilePath/zipBase64 is required."),
        confirm: z.boolean().optional().describe("Must be true to proceed."),
      },
    },
    writeHandler(
      async ({ artifactId, version, name, zipFilePath, zipBase64 }) => {
        if (!zipFilePath && !zipBase64) throw new Error("Provide either zipFilePath or zipBase64.");
        if (zipFilePath && zipBase64) throw new Error("Provide only one of zipFilePath or zipBase64, not both.");
        const buf = zipFilePath ? await readFile(zipFilePath) : Buffer.from(zipBase64, "base64");

        let effectiveName = name;
        if (!effectiveName) {
          const current = await cpiGet(`/IntegrationDesigntimeArtifacts(Id=${odataString(artifactId)},Version=${odataString(version)})`);
          effectiveName = current && current.Name;
        }

        const result = await cpiRequest(
          "PUT",
          `/IntegrationDesigntimeArtifacts(Id=${odataString(artifactId)},Version=${odataString(version)})`,
          { body: { Name: effectiveName, ArtifactContent: buf.toString("base64") } }
        );
        return { artifactId, version, name: effectiveName, zipSizeBytes: buf.length, result };
      },
      { action: ({ artifactId }) => `overwrite integration flow '${artifactId}' with raw pushed zip content` }
    )
  );

  // --- Configurations (externalized parameters) ---------------------------
  registerScopedTool(server,
    "get_flow_configurations",
    {
      title: "Get Flow Externalized Configurations",
      description:
        "Get the externalized configuration parameters of an integration flow (endpoints, credentials names, etc.).",
      inputSchema: { artifactId: z.string(), version: z.string().default("active") },
    },
    readHandler(({ artifactId, version }) =>
      cpiGet(
        `/IntegrationDesigntimeArtifacts(Id=${odataString(artifactId)},Version=${odataString(version)})/Configurations`
      )
    )
  );

  registerScopedTool(server,
    "update_flow_configuration",
    {
      title: "Update Flow Configuration Parameter",
      description:
        "Update a single externalized configuration parameter of an integration flow. Requires ALLOW_WRITE.",
      inputSchema: {
        artifactId: z.string(),
        version: z.string().default("active"),
        parameterKey: z.string(),
        parameterValue: z.string(),
        dataType: z.string().default("xsd:string"),
        confirm: z.boolean().optional().describe("Must be true to proceed."),
      },
    },
    writeHandler(
      ({ artifactId, version, parameterKey, parameterValue, dataType }) =>
        cpiRequest(
          "PUT",
          `/IntegrationDesigntimeArtifacts(Id=${odataString(artifactId)},Version=${odataString(version)})/$links/Configurations(${odataString(parameterKey)})`,
          { body: { ParameterValue: parameterValue, DataType: dataType } }
        ),
      { action: ({ parameterKey, artifactId }) => `update parameter '${parameterKey}' on flow '${artifactId}'` }
    )
  );

  // --- Custom tags / resources -------------------------------------------
  registerScopedTool(server,
    "get_flow_resources",
    {
      title: "Get Flow Resources",
      description: "List the resources (scripts, XSDs, WSDLs, mappings) inside an integration flow.",
      inputSchema: { artifactId: z.string(), version: z.string().default("active") },
    },
    readHandler(({ artifactId, version }) =>
      cpiGet(
        `/IntegrationDesigntimeArtifacts(Id=${odataString(artifactId)},Version=${odataString(version)})/Resources`
      )
    )
  );

  // --- Create integration flow -------------------------------------------
  registerScopedTool(server,
    "create_integration_flow",
    {
      title: "Create Integration Flow",
      description:
        "Create a new (empty) integration flow in a package — a default flow at version 1.0.0 that " +
        "you then edit in the Integration Suite web editor. Requires ALLOW_WRITE.",
      inputSchema: {
        packageId: z.string(),
        id: z.string().describe("Technical Id (no spaces)."),
        name: z.string(),
        description: z.string().optional(),
        confirm: z.boolean().optional().describe("Must be true to proceed."),
      },
    },
    writeHandler(
      ({ packageId, id, name, description }) =>
        cpiRequest("POST", "/IntegrationDesigntimeArtifacts", {
          body: { Name: name, Id: id, PackageId: packageId, Description: description || "" },
        }),
      { action: ({ id, packageId }) => `create integration flow '${id}' in package '${packageId}'` }
    )
  );

  // --- Save integration flow as a version --------------------------------
  registerScopedTool(server,
    "save_integration_flow_as_version",
    {
      title: "Save Integration Flow as Version",
      description:
        "Save the current draft ('active') of an integration flow as a new version, with an optional " +
        "version comment. Requires ALLOW_WRITE. (The comment is applied to the artifact before the " +
        "version is saved, since the SaveAsVersion API doesn't take one directly.)",
      inputSchema: {
        artifactId: z.string(),
        version: z.string().describe("New version to save, e.g. '1.0.1'."),
        comment: z.string().optional().describe("Version comment / note."),
        confirm: z.boolean().optional().describe("Must be true to proceed."),
      },
    },
    writeHandler(
      async ({ artifactId, version, comment }) => {
        let commentApplied = false;
        let commentNote = null;
        if (comment) {
          // Setting the comment requires a PUT that includes the artifact Name, so fetch it first.
          // Best-effort: never let the comment step block the version save.
          try {
            const art = await cpiGet(
              `/IntegrationDesigntimeArtifacts(Id=${odataString(artifactId)},Version=${odataString("active")})`
            );
            await cpiRequest(
              "PUT",
              `/IntegrationDesigntimeArtifacts(Id=${odataString(artifactId)},Version=${odataString("active")})`,
              { body: { Name: art.Name, Comment: comment } }
            );
            commentApplied = true;
          } catch (e) {
            commentNote = `Comment could not be applied (${e.message}); version was still saved.`;
          }
        }
        const result = await cpiInvoke("IntegrationDesigntimeArtifactSaveAsVersion", {
          Id: artifactId,
          SaveAsVersion: version,
        });
        return { artifactId, savedVersion: version, comment: comment || null, commentApplied, commentNote, result };
      },
      { action: ({ artifactId, version }) => `save flow '${artifactId}' as version ${version}` }
    )
  );
}
