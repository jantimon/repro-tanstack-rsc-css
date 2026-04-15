import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { Card } from "../components/Card";

const getCard = createServerFn().handler(async () => {
  return renderServerComponent(<Card />);
});

export const Route = createFileRoute("/")({
  loader: async () => {
    const Renderable = await getCard();
    return { Card: Renderable };
  },
  component: HomePage,
});

function HomePage() {
  const { Card } = Route.useLoaderData();
  return <>{Card}</>;
}
