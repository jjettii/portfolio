// TODO (deferred by owner, 2026-11-03): Keep COMMENT_DIGEST_ENABLED=false.
// The deployed queue/scheduler implements a 30-minute quiet period per project;
// every new comment on any project video resets that project's timer.
// Recipient: mail@jordanettinger.com (verified in Cloudflare; inbox is Proton).
// Cloudflare's dashboard requires Workers Paid for Email Sending; the owner
// declined upgrading. No sender domain was onboarded and no test digest was sent.
// When resuming, consider a free email provider such as Resend, recheck its limits,
// and replace COMMENT_EMAIL.send below with the chosen server-side integration.
// Preserve Proton's MX/SPF/DKIM records; authenticate a dedicated sending subdomain.
// Migrations 0002/0003 are already applied remotely: do not replay them.
// The insert trigger STILL queues comments while delivery is disabled. Before
// enabling, explicitly decide whether to send or discard that accumulated backlog
// so old feedback does not unexpectedly generate emails months later.
// Run digest tests, verify a real delivery, then enable and deploy deliberately.
// See README.md "Comment email digests" for deployment status and retry behavior.
const QUIET_SECONDS = 30 * 60;
const LEASE_SECONDS = 15 * 60;

function timecode(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function digestMessage(project, comments, env) {
  const url = new URL('/review/', env.REVIEW_SITE_URL || 'https://jordanettinger.com');
  url.searchParams.set('id', project.project_id);
  const lines = [
    `${comments.length} new comment${comments.length === 1 ? '' : 's'} on ${project.name}`,
    '', 'No additional comments have been added to this project for 30 minutes.',
    '', `Open project: ${url.href}`, '',
  ];
  let videoId;
  for (const comment of comments.slice(0, 100)) {
    if (comment.video_id !== videoId) {
      videoId = comment.video_id;
      lines.push('', comment.title, '');
    }
    lines.push(`${comment.author} at ${timecode(comment.timestamp_seconds)}`, comment.body.slice(0, 4000), '');
  }
  if (comments.length > 100) lines.push('Additional comments are available in the project.');
  lines.push('Opening this email does not mark comments as read.');
  return {
    to: env.COMMENT_DIGEST_TO,
    from: env.COMMENT_DIGEST_FROM,
    subject: `New review comments: ${project.name}`.replace(/[\r\n]/g, ' ').slice(0, 200),
    text: lines.join('\n'),
  };
}

export async function sendCommentDigests(env, now = Math.floor(Date.now() / 1000)) {
  if (env.COMMENT_DIGEST_ENABLED !== 'true') return;
  if (!env.COMMENT_EMAIL?.send || !env.COMMENT_DIGEST_TO || !env.COMMENT_DIGEST_FROM) {
    throw new Error('Comment digests are enabled but email configuration is incomplete');
  }
  const { results: projects } = await env.DB.prepare(`
    SELECT q.*, r.name FROM comment_digest_projects q JOIN reviews r ON r.id = q.project_id
    WHERE q.last_comment_at <= ? AND q.lease_until <= ?
      AND EXISTS (SELECT 1 FROM comment_digest_outbox o WHERE o.project_id = q.project_id)
    ORDER BY q.last_comment_at LIMIT 10
  `).bind(now - QUIET_SECONDS, now).all();

  for (const project of projects) {
    const token = crypto.randomUUID();
    const claim = await env.DB.prepare(`UPDATE comment_digest_projects SET lease_until = ?, lease_token = ?
      WHERE project_id = ? AND latest_seq = ? AND lease_until <= ? AND last_comment_at <= ?`)
      .bind(now + LEASE_SECONDS, token, project.project_id, project.latest_seq, now, now - QUIET_SECONDS).run();
    if (!claim.meta.changes) continue;
    try {
      const { results: comments } = await env.DB.prepare(`
        SELECT c.*, v.title FROM comment_digest_outbox o
        JOIN comments c ON c.id = o.comment_id JOIN videos v ON v.stream_uid = c.video_id
        WHERE o.project_id = ? AND o.seq <= ? AND v.review_id = o.project_id
        ORDER BY v.created_at, v.stream_uid, o.seq
      `).bind(project.project_id, project.latest_seq).all();
      // Deleted comments are omitted; read/completion status does not affect delivery.
      if (comments.length) await env.COMMENT_EMAIL.send(digestMessage(project, comments, env));
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM comment_digest_outbox WHERE project_id = ? AND seq <= ?
          AND EXISTS (SELECT 1 FROM comment_digest_projects WHERE project_id = ? AND lease_token = ?)`)
          .bind(project.project_id, project.latest_seq, project.project_id, token),
        env.DB.prepare(`UPDATE comment_digest_projects SET lease_until = 0, lease_token = NULL
          WHERE project_id = ? AND lease_token = ?`).bind(project.project_id, token),
      ]);
    } catch (error) {
      // Keep the batch for retry. Do not log comment text or addresses.
      console.error('Comment digest failed', project.project_id, error.code || 'SEND_OR_DATABASE_FAILURE');
      await env.DB.prepare(`UPDATE comment_digest_projects SET lease_until = ?, lease_token = NULL
        WHERE project_id = ? AND lease_token = ?`).bind(now + 5 * 60, project.project_id, token).run();
    }
  }
  // Remove queue metadata for projects that were deleted.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM comment_digest_outbox WHERE project_id NOT IN (SELECT id FROM reviews)'),
    env.DB.prepare('DELETE FROM comment_digest_projects WHERE project_id NOT IN (SELECT id FROM reviews)'),
  ]);
}
