import { Nav } from "@/components/chrome/Nav";
import { DOCS } from "@/lib/docs";
import { REPO_URL } from "@/lib/measurements";
import styles from "./docs.module.css";

/**
 * docs.sortis.xyz
 *
 * Four pages, all written. A short honest page beats a promise of six, and the
 * previous placeholder listing pages that did not exist was the worst kind of
 * overclaim: checkable in one click.
 */
export default function DocsIndex() {
  return (
    <>
      <Nav surface="marketing" />
      <main className={styles.main}>
        <div className={styles.shell}>
          <aside className={styles.rail}>
            <div className={styles.railGroup}>
              <span className={styles.railLabel}>Documentation</span>
              {DOCS.map((doc) => (
                <a key={doc.slug} className={styles.railLink} href={`#${doc.slug}`}>
                  {doc.title}
                </a>
              ))}
            </div>
            <div className={styles.railGroup}>
              <span className={styles.railLabel}>Product</span>
              <a className={styles.railLink} href="/app">
                Open the app
              </a>
              <a className={styles.railLink} href="/app/verify">
                Verify a draw
              </a>
            </div>
            <div className={styles.railGroup}>
              <span className={styles.railLabel}>Source</span>
              <a className={styles.railLink} href={REPO_URL}>
                Repository
              </a>
              <a className={styles.railLink} href={`${REPO_URL}/blob/main/test/HCU.t.ts`}>
                HCU measurements
              </a>
            </div>
          </aside>

          <div className={styles.inner}>
          <p className="eyebrow">Documentation</p>
          <h1 className={styles.title}>Sortis</h1>
          <p className={styles.lede}>
            Confidential prize-linked savings on the Zama Protocol. Four pages: what it is, how the
            register works, what stays private, and what it does not do.
          </p>

          <nav className={styles.index}>
            {DOCS.map((doc, i) => (
              <a key={doc.slug} className={styles.indexRow} href={`#${doc.slug}`}>
                <span className={styles.indexNumber}>{String(i + 1).padStart(2, "0")}</span>
                <span className={styles.indexTitle}>{doc.title}</span>
                <span className={styles.indexBlurb}>{doc.blurb}</span>
              </a>
            ))}
          </nav>

          {DOCS.map((doc) => (
            <article key={doc.slug} id={doc.slug} className={styles.article}>
              <h2 className={styles.articleTitle}>{doc.title}</h2>
              {doc.body.map((block, i) =>
                block.type === "p" ? (
                  <p key={i} className={styles.p}>
                    {block.text}
                  </p>
                ) : block.type === "h" ? (
                  <h3 key={i} className={styles.h3}>
                    {block.text}
                  </h3>
                ) : block.type === "code" ? (
                  <pre key={i} className={styles.pre}>
                    {block.text}
                  </pre>
                ) : (
                  <ul key={i} className={styles.ul}>
                    {block.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ),
              )}
            </article>
          ))}
          </div>
        </div>
      </main>
    </>
  );
}
