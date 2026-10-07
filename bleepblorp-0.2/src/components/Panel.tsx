import type { CSSProperties, ReactNode } from "react";

const shell: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: "14px 16px",
  borderRadius: 10,
  background: "var(--surface)",
  border: "1px solid var(--border)",
  minWidth: 0,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
};

export function Panel({
  title,
  children,
  style,
}: {
  title: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section style={{ ...shell, ...style }}>
      <h3 style={titleStyle}>{title}</h3>
      {children}
    </section>
  );
}
