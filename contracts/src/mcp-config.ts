import {z} from 'zod';
export const McpConnection=z.object({id:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/),name:z.string().min(1),url:z.string().url(),token_env:z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional()}).strict();
