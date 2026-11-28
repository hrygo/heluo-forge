/**
 * 需求域只读模型工具集（需求、用户故事及 RMP 文档只读工具，对齐 CORP-DSH-ENG-003）。
 */
import { json, TOOL_OUTPUT, toolFailure } from '../../shared/tool-helpers.mjs';

export const REQUIREMENT_TOOL_NAMES = Object.freeze([
  'forge_workbench_requirement_read',
  'forge_workbench_story_read',
  'forge_workbench_rmp_doc_search',
  'forge_workbench_rmp_outline_read',
  'forge_workbench_rmp_section_read',
]);

/**
 * 构造需求域只读工具定义。
 *
 * @param {{
 *   readRequirementDetail: Function,
 *   readStoryDetail: Function,
 *   searchRmpDocs: Function,
 *   getRmpOutline: Function,
 *   readRmpSection: Function,
 * }} service
 */
export function buildRequirementTools(service) {
  return [
    {
      name: 'forge_workbench_requirement_read',
      description:
        'Read-only lookup of a single requirement detail from DevOps platform (requirement number, title, ' +
        'stage/state, manager & businessOwner, sanitized background/description, linked RMP documents, and portalUrl). ' +
        'Never writes to the platform.',
      parameters: {
        type: 'object',
        properties: {
          requirementId: {
            type: 'string',
            description: 'Requirement id or requirement number (e.g. REQ-2026-0001 or <requirement-id>).',
          },
        },
        required: ['requirementId'],
        additionalProperties: false,
      },
      output: TOOL_OUTPUT,
      async execute(args) {
        try {
          return json(await service.readRequirementDetail({ requirementId: args?.requirementId }));
        } catch (err) {
          return toolFailure('forge_workbench_requirement_read', err);
        }
      },
    },
    {
      name: 'forge_workbench_story_read',
      description:
        'Read-only lookup of a user story detail (story code, summary, parent requirement, existing acceptance ' +
        'criteria, associated systemChanges codes for forge_devops_change_context, optional sprint estimate, and portalUrl). ' +
        'Never writes to the platform.',
      parameters: {
        type: 'object',
        properties: {
          storyId: {
            type: 'string',
            description: 'Story id or code (e.g. STORY-2026-0001 or <story-id>).',
          },
        },
        required: ['storyId'],
        additionalProperties: false,
      },
      output: TOOL_OUTPUT,
      async execute(args) {
        try {
          return json(await service.readStoryDetail({ storyId: args?.storyId }));
        } catch (err) {
          return toolFailure('forge_workbench_story_read', err);
        }
      },
    },
    {
      name: 'forge_workbench_rmp_doc_search',
      description:
        'Search requirement specification documents in RMP (Requirements Management Platform) via /sso exchange. ' +
        'Returns document ids, docname, version, status, and portalUrl.',
      parameters: {
        type: 'object',
        properties: {
          quickSearch: { type: 'string', description: 'Keyword matching doc name or code (optional).' },
          reqCode: { type: 'string', description: 'Optional requirement code filter.' },
          latestOnly: { type: 'boolean', description: 'Whether to query latest published versions only.' },
        },
        additionalProperties: false,
      },
      output: TOOL_OUTPUT,
      async execute(args) {
        try {
          return json(await service.searchRmpDocs({
            quickSearch: args?.quickSearch ?? '',
            reqCode: args?.reqCode ?? '',
            latestOnly: Boolean(args?.latestOnly),
          }));
        } catch (err) {
          return toolFailure('forge_workbench_rmp_doc_search', err);
        }
      },
    },
    {
      name: 'forge_workbench_rmp_outline_read',
      description:
        'Read the section outline tree of an RMP document (using form-urlencoded query) so specific section iids ' +
        'can be read via forge_workbench_rmp_section_read.',
      parameters: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: 'RMP document id (docid / iid).' },
        },
        required: ['docId'],
        additionalProperties: false,
      },
      output: TOOL_OUTPUT,
      async execute(args) {
        try {
          return json(await service.getRmpOutline({ docId: args?.docId }));
        } catch (err) {
          return toolFailure('forge_workbench_rmp_outline_read', err);
        }
      },
    },
    {
      name: 'forge_workbench_rmp_section_read',
      description:
        'Read sanitized plain text content of a single RMP document outline section by iid. ' +
        'Detects <p class="nodata"></p> empty placeholders and truncates beyond 16 KiB UTF-8.',
      parameters: {
        type: 'object',
        properties: {
          iid: { type: 'string', description: 'RMP section id (idoc_id / iid from outline tree).' },
        },
        required: ['iid'],
        additionalProperties: false,
      },
      output: TOOL_OUTPUT,
      async execute(args) {
        try {
          return json(await service.readRmpSection({ iid: args?.iid }));
        } catch (err) {
          return toolFailure('forge_workbench_rmp_section_read', err);
        }
      },
    },
  ];
}
