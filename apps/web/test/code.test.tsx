import { render, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { Code } from "@/components/code";

test("shows plain text, then the highlighted code with the language from the path", async () => {
  const { container } = render(<Code code={"fn main() {}\n"} path="src/main.rs" lineNumbers />);
  expect(container).toHaveTextContent("fn main() {}");
  await waitFor(() => expect(container.querySelector("pre.line-numbers")).not.toBeNull());
  expect(container.querySelector("#L1")).toHaveTextContent("fn main() {}");
  expect(container.querySelector("pre span[style*='--shiki-dark']")).not.toBeNull();
});

test("shows the new plain text, not the old highlighting, when the code changes", async () => {
  const { container, rerender } = render(<Code code={"const a = 1;\n"} lang="ts" />);
  await waitFor(() => expect(container.querySelector("pre span[style*='--shiki-dark']")).not.toBeNull());
  rerender(<Code code={"const b = 2;\n"} lang="ts" />);
  expect(container).toHaveTextContent("const b = 2;");
  expect(container).not.toHaveTextContent("const a = 1;");
  await waitFor(() => expect(container.querySelector("pre span[style*='--shiki-dark']")).not.toBeNull());
  expect(container).toHaveTextContent("const b = 2;");
});
