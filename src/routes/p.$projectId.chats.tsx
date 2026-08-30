import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/p/$projectId/chats")({ component: ChatsLayout });

function ChatsLayout() {
  return <Outlet />;
}
