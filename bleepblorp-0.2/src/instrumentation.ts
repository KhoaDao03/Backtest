export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getLiveFeed } = await import("@/server/feed/engine");
  getLiveFeed().wake();
}
