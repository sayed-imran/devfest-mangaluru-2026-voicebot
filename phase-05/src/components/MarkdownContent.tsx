"use client";

import ReactMarkdown from "react-markdown";

type Props = {
  text: string;
  className?: string;
};

export default function MarkdownContent({ text, className }: Props) {
  if (!text) return null;

  return (
    <div className={className ? `markdown ${className}` : "markdown"}>
      <ReactMarkdown
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
