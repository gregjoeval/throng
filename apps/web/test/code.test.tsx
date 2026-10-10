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
