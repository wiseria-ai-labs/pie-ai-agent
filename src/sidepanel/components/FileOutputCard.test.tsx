import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { FileOutputCard } from "./FileOutputCard";

afterEach(() => cleanup());

const saveBtn = () => screen.getByRole("button", { name: /Save$/ });

describe("FileOutputCard", () => {
  it("renders filename + type·size", () => {
    render(<FileOutputCard artifactId="a" filename="pie/report.md" mime="text/markdown" size={12300} onDownload={vi.fn()} />);
    // title drops the extension (the type is shown on the meta line instead)
    expect(screen.getByText("report")).toBeTruthy();
    expect(screen.queryByText("report.md")).toBeNull();
    expect(screen.getByText(/MARKDOWN/)).toBeTruthy();
    expect(screen.getByText(/12\.0 KB/)).toBeTruthy();
  });

  it("Save asks the SW to open the native Save dialog", async () => {
    const onDownload = vi.fn().mockResolvedValue({ status: "ok" });
    render(<FileOutputCard artifactId="a7" filename="pie/x.md" mime="text/markdown" size={10} onDownload={onDownload} />);
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onDownload).toHaveBeenCalledWith("a7"));
  });

  it("renders the head preview and the truncation hint", () => {
    render(
      <FileOutputCard
        artifactId="a" filename="pie/x.md" mime="text/markdown" size={10}
        preview={"# title\nbody"} totalLines={118} onDownload={vi.fn()}
      />,
    );
    expect(screen.getByText(/# title/)).toBeTruthy();
    expect(screen.getByText(/118/)).toBeTruthy();
  });

  it("switches to expired state when the save resolves expired", async () => {
    const onDownload = vi.fn().mockResolvedValue({ status: "expired" });
    render(<FileOutputCard artifactId="a" filename="pie/x.md" mime="text/markdown" size={10} onDownload={onDownload} />);
    fireEvent.click(saveBtn());
    await waitFor(() => expect((saveBtn() as HTMLButtonElement).disabled).toBe(true));
  });

  it("shows expired on mount (no click) when onProbe resolves false", async () => {
    const onProbe = vi.fn().mockResolvedValue(false);
    render(<FileOutputCard artifactId="a" filename="pie/x.md" mime="text/markdown" size={10} onDownload={vi.fn()} onProbe={onProbe} />);
    await waitFor(() => expect((saveBtn() as HTMLButtonElement).disabled).toBe(true));
    expect(onProbe).toHaveBeenCalledWith("a");
  });

  it("stays saveable when onProbe resolves true", async () => {
    const onProbe = vi.fn().mockResolvedValue(true);
    render(<FileOutputCard artifactId="a" filename="pie/x.md" mime="text/markdown" size={10} onDownload={vi.fn()} onProbe={onProbe} />);
    await waitFor(() => expect(onProbe).toHaveBeenCalledWith("a"));
    expect((saveBtn() as HTMLButtonElement).disabled).toBe(false);
  });
});
