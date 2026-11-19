// Servidor MCP remoto (Agents SDK, createMcpHandler). Sin Durable Object.
// Encima de las mismas operaciones que la API HMAC del bot. No aprueba ni publica.
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { DomainError } from '../../core/domain/errors.js';
import { D1Repository } from '../repository/d1-repository.js';
import { R2ObjectStore } from '../storage/r2-object-store.js';
import {
  claimEncargo, listQueued, readClaimedOrigin, reviewEncargoForBot, submitEncargoResult,
} from '../../workflows/encargos.js';

export const MCP_PATH = '/mcp';
export const MCP_ACTOR = 'mcp';
export const MCP_TOOL_NAMES = Object.freeze([
  'reclamar_encargo',
  'leer_origen',
  'subir_resultado',
  'revisar_estado',
]);

const encargoId = z.string().describe('Identificador del encargo');

function textResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errorResult(error) {
  const payload = error instanceof DomainError
    ? { code: error.code, message: error.message }
    : { code: 'INTERNAL', message: 'No se pudo completar la herramienta' };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

async function runTool(fn) {
  try {
    return textResult(await fn());
  } catch (error) {
    return errorResult(error);
  }
}

function deps(env) {
  return {
    repo: new D1Repository(env.DB),
    r2: env.MEDIA_R2 ? new R2ObjectStore(env.MEDIA_R2) : null,
    now: () => new Date().toISOString(),
  };
}

export function createInfluServer(env) {
  const server = new McpServer({ name: 'influ-encargos', version: '0.1.0' });
  const { repo, r2, now } = deps(env);

  server.registerTool('reclamar_encargo', {
    title: 'Reclamar encargo',
    description: 'Reserva un encargo que está en la cola. No aprueba ni publica.',
    inputSchema: z.object({ encargo_id: encargoId }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ encargo_id: id }) => runTool(() => claimEncargo(repo, { encargoId: id, now: now(), actor: MCP_ACTOR })));

  server.registerTool('leer_origen', {
    title: 'Leer origen',
    description: 'Lee la nota y hace head de los objetos R2 de origen de un encargo ya reclamado. No devuelve el vídeo: en el plan gratuito el Worker no tiene margen de CPU para copiar el archivo. No aprueba ni publica.',
    inputSchema: z.object({ encargo_id: encargoId }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ encargo_id: id }) => runTool(() => readClaimedOrigin(repo, { encargoId: id, now: now(), r2, actor: MCP_ACTOR })));

  server.registerTool('subir_resultado', {
    title: 'Subir resultado',
    description: 'Entrega la pieza de un encargo reclamado: synthetic, huella y, si aplica, la clave R2 de la pieza. Es el mismo paso que POST /v1/encargos/:id/result. No aprueba ni publica.',
    inputSchema: z.object({
      encargo_id: encargoId,
      synthetic: z.boolean().describe('true si el bot ha generado o alterado'),
      content_hash: z.string().describe('Huella SHA-256 hex de la versión'),
      file_sha256: z.string().optional().describe('SHA-256 hex del archivo de origen, si lo hay'),
      failed: z.boolean().optional(),
      error_code: z.string().optional(),
      batch_id: z.string().optional(),
      deliverable: z.object({
        r2_key: z.string(),
        sha256: z.string(),
        mime: z.string(),
        size_bytes: z.number(),
      }).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args) => runTool(() => {
    const body = {
      synthetic: args.synthetic,
      content_hash: args.content_hash,
    };
    if (args.file_sha256 !== undefined) body.file_sha256 = args.file_sha256;
    if (args.failed !== undefined) body.failed = args.failed;
    if (args.error_code !== undefined) body.error = { code: args.error_code };
    if (args.batch_id !== undefined) body.batch_id = args.batch_id;
    if (args.deliverable !== undefined) body.deliverable = args.deliverable;
    return submitEncargoResult(repo, { encargoId: args.encargo_id, body, now: now(), r2, actor: MCP_ACTOR });
  }));

  server.registerTool('revisar_estado', {
    title: 'Revisar estado',
    description: 'Estado de un encargo, o la cola queued si no se pasa id. Sirve para la revisión de respaldo. No aprueba ni publica.',
    inputSchema: z.object({
      encargo_id: encargoId.optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ encargo_id: id }) => runTool(() => (id ? reviewEncargoForBot(repo, id) : listQueued(repo, 'queued'))));

  return server;
}

export function createInfluMcpHandler(env) {
  return createMcpHandler(() => createInfluServer(env), {
    route: MCP_PATH,
    // El bearer ya se comprobó antes de llegar aquí. Grok Bot llama desde sus servidores y puede traer Origin.
    allowedOriginHostnames: '*',
  });
}
