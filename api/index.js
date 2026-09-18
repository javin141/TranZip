/**
 * Vercel serverless entry point.
 *
 * Vercel does not keep a Node process alive between requests; instead every
 * /api/* request is rewritten (see vercel.json) to this function, which
 * delegates to the exact same Express app used locally and on Render. The
 * Express app is itself a (req, res) handler, which is all @vercel/node needs.
 */
import app from '../server/index.js';

export default app;
