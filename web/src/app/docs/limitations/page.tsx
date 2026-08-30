import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DocPage } from "@/components/docs/DocPage";
import { DOCS } from "@/lib/docs";

export const metadata: Metadata = {
  title: "Limitations | Sortis docs",
  description: "What is not built, and the named path forward.",
};

export default function Page() {
  const doc = DOCS.find((d) => d.slug === "limitations");
  // The slug is a literal above, so this is unreachable unless lib/docs.ts is
  // edited without its route. Failing loudly beats rendering an empty shell.
  if (!doc) notFound();
  return <DocPage doc={doc} />;
}
