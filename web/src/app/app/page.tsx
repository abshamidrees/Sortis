import { DrawScreen } from "@/components/DrawScreen";

/**
 * app.sortis.xyz  and  localhost:3000/app
 *
 * Rendered rather than redirected. A redirect to /app/draw would show
 * app.sortis.xyz/app/draw in the address bar, doubling the segment the
 * middleware exists to hide.
 */
export default function AppIndex() {
  return <DrawScreen />;
}
