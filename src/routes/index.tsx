import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import styles from "../components/Card.module.css";

const getCard = createServerFn().handler(async () => {
  return renderServerComponent(
    <div className={styles.card}>
      <h2 className={styles.title}>Server Rendered</h2>
    </div>
  );
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
