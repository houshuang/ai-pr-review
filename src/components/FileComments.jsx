import { h } from "preact";
import { getCommentThreads } from "../api";
import { md, timeAgo } from "../utils";

export function FileComments({ filePath }) {
  const threads = getCommentThreads(filePath);
  if (!threads.length) return null;

  return (
    <div className="file-comments">
      {threads.map((thread) => (
        <div className="comment-thread" key={thread.id}>
          <div className="comment">
            <div className="comment-meta">
              <span className="comment-author">{thread.user}</span>
              {thread.line && (
                <span className="comment-line">
                  {thread.startLine && thread.startLine !== thread.line
                    ? `Lines ${thread.startLine}\u2013${thread.line}`
                    : `Line ${thread.line}`}
                </span>
              )}
              <span className="comment-time">{timeAgo(thread.createdAt)}</span>
            </div>
            <div className="comment-body" dangerouslySetInnerHTML={{ __html: md(thread.body) }} />
          </div>

          {thread.replies.map((reply) => (
            <div className="comment comment-reply" key={reply.id}>
              <div className="comment-meta">
                <span className="comment-author">{reply.user}</span>
                <span className="comment-time">{timeAgo(reply.createdAt)}</span>
              </div>
              <div className="comment-body" dangerouslySetInnerHTML={{ __html: md(reply.body) }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
