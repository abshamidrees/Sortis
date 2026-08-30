import Link from "next/link";

import { DOCS, type Doc } from "@/lib/docs";
import styles from "@/app/docs/docs.module.css";

/**
 * One documentation page, rendered from its blocks.
 *
 * The content is data in `lib/docs.ts` rather than JSX in four files, because
 * the numbers in it are imported from `lib/measurements.ts`. A figure quoted
 * in prose that does not move when the measurement moves is the thing the
 * craft standard is most concerned about, and it is easy to write by hand and
 * hard to notice afterwards.
 */
export function DocPage({ doc }: { doc: Doc }) {
  const index = DOCS.findIndex((d) => d.slug === doc.slug);
  const previous = index > 0 ? DOCS[index - 1] : null;
  const next = index < DOCS.length - 1 ? DOCS[index + 1] : null;

  return (
    <>
      <p className="eyebrow">
        Documentation, {String(index + 1).padStart(2, "0")} of{" "}
        {String(DOCS.length).padStart(2, "0")}
      </p>
      <h1 className={styles.title}>{doc.title}</h1>
      <p className={styles.lede}>{doc.blurb}</p>

      <article className={styles.article}>
        {doc.body.map((block, i) =>
          block.type === "p" ? (
            <p key={i} className={styles.p}>
              {block.text}
            </p>
          ) : block.type === "h" ? (
            <h2 key={i} className={styles.h3}>
              {block.text}
            </h2>
          ) : block.type === "code" ? (
            <pre key={i} className={styles.pre}>
              {block.text}
            </pre>
          ) : block.type === "note" ? (
            /* A stated limit, marked so it cannot be skimmed past as prose. */
            <p key={i} className={styles.note}>
              {block.text}
            </p>
          ) : (
            <ul key={i} className={styles.ul}>
              {block.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )
        )}
      </article>

      {/* Reading order, because four routes lose the scroll that used to
          carry you from one section to the next. */}
      <nav className={styles.pager}>
        {previous ? (
          <Link
            className={styles.pagerLink}
            href={`/docs/${previous.slug}`}
            data-side="prev"
          >
            <span className={styles.pagerLabel}>Previous</span>
            <span className={styles.pagerTitle}>{previous.title}</span>
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link
            className={styles.pagerLink}
            href={`/docs/${next.slug}`}
            data-side="next"
          >
            <span className={styles.pagerLabel}>Next</span>
            <span className={styles.pagerTitle}>{next.title}</span>
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </>
  );
}
