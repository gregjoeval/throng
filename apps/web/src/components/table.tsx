// The pieces the settings and tokens tables share.

import type { ReactNode } from "react";

/** A column heading. */
export function Th({ children }: { children: ReactNode }) {
  return <th className="px-2 py-2 font-medium">{children}</th>;
}
