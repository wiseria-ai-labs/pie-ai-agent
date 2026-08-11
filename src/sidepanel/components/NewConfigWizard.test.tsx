import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import NewConfigWizard from "./NewConfigWizard";
import * as cp from "@/lib/custom-providers";
import * as ocFetch from "@/lib/openai-compat-models-fetch";

// custom-providers reads chrome.storage; stub list to empty for builtin-only tests
vi.mock("@/lib/custom-providers", async (orig) => {
  const actual = await orig<typeof import("@/lib/custom-providers")>();
  return { ...actual, listCustomProviders: vi.fn(async () => []) };
});

afterEach(() => cleanup());

describe("NewConfigWizard (builtin path)", () => {
  it("renders provider dropdown, no step-1 long list", () => {
    render(<NewConfigWizard onCreate={vi.fn()} onCancel={vi.fn()} onTest={vi.fn()} />);
    expect(screen.getByRole("button", { name: /select provider/i })).toBeTruthy();
    expect(screen.queryByText(/api key/i)).toBeFalsy();
  });

  it("selecting a builtin provider reveals the instance form", async () => {
    render(<NewConfigWizard onCreate={vi.fn()} onCancel={vi.fn()} onTest={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByText("Anthropic"));
    await waitFor(() => expect(screen.getAllByLabelText(/api key/i).length).toBeGreaterThan(0));
    expect(screen.queryByText(/LOCKED/)).toBeFalsy();
  });

  it("creates a builtin instance with payload", async () => {
    const onCreate = vi.fn();
    render(<NewConfigWizard onCreate={onCreate} onCancel={vi.fn()} onTest={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByText("Anthropic"));
    const keyInput = (await screen.findAllByLabelText(/api key/i)).find((e) => e.tagName === "INPUT")!;
    fireEvent.change(keyInput, { target: { value: "sk-ant-x" } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    expect(onCreate).toHaveBeenCalledWith("anthropic", expect.objectContaining({ apiKey: "sk-ant-x" }));
  });

  // #3: configured providers stay visible (chip + disabled select) instead of
  // being hidden — hiding removed the only edit/delete entry for custom providers.
  it("shows already-configured providers as non-selectable instead of hiding them", async () => {
    const onCreate = vi.fn();
    render(
      <NewConfigWizard
        existingProviderRefs={["anthropic"]}
        onCreate={onCreate}
        onCancel={vi.fn()}
        onTest={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    const row = screen.getByText("Anthropic").closest("button")!;
    expect(row.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Configured")).toBeTruthy();
    fireEvent.click(row);
    // not selected → no API key form appeared for it
    expect(screen.queryByLabelText("api key")).toBeNull();
    // unconfigured providers remain selectable
    expect((screen.getByText("OpenAI").closest("button")!).hasAttribute("disabled")).toBe(false);
  });
});

describe("NewConfigWizard (custom path)", () => {
  it("new custom: Test uses draft baseUrl and candidate model before saving", async () => {
    const onTest = vi.fn();
    render(<NewConfigWizard onCreate={vi.fn()} onCancel={vi.fn()} onTest={onTest} />);
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByText(/new custom provider/i));
    fireEvent.change(screen.getByPlaceholderText(/my custom provider/i), { target: { value: "Proxy" } });
    fireEvent.change(screen.getByPlaceholderText(/api\.example\.com/i), { target: { value: "https://proxy/v1" } });
    fireEvent.click(screen.getByText(/add custom model/i));
    fireEvent.change(screen.getByPlaceholderText(/^model id$/i), { target: { value: "gpt-test" } });
    fireEvent.click(screen.getByText("Save", { selector: "button" }));
    const keyInput = (await screen.findAllByLabelText(/api key/i)).find(
      (e) => e.tagName === "INPUT" && e.getAttribute("aria-label") === "api key",
    )!;
    fireEvent.change(keyInput, { target: { value: "sk-x" } });
    fireEvent.click(screen.getByText("Test", { selector: "button" }));

    expect(onTest).toHaveBeenCalledWith(
      "custom:__draft__",
      expect.objectContaining({ apiKey: "sk-x", customModels: ["gpt-test"] }),
      expect.objectContaining({
        baseUrl: "https://proxy/v1",
        providerName: "Proxy",
        candidateModels: [expect.objectContaining({ id: "gpt-test" })],
      }),
    );
  });

  it("shows success in the Test button and failure in the footer banner", async () => {
    const { rerender } = render(
      <NewConfigWizard
        onCreate={vi.fn()}
        onCancel={vi.fn()}
        onTest={vi.fn()}
        testing
        testResult={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByText("Anthropic"));
    const keyInput = (await screen.findAllByLabelText(/api key/i)).find((e) => e.tagName === "INPUT")!;
    fireEvent.change(keyInput, { target: { value: "sk-ant-x" } });
    const testButton = screen.getByRole("button", { name: /testing/i }) as HTMLButtonElement;
    expect(testButton.disabled).toBe(true);

    rerender(
      <NewConfigWizard
        onCreate={vi.fn()}
        onCancel={vi.fn()}
        onTest={vi.fn()}
        testing={false}
        testResult={{ ok: true, message: "" }}
      />,
    );
    expect(screen.getByRole("button", { name: /test ok/i })).toBeTruthy();
    expect(screen.queryByText(/test ok/i, { selector: "div" })).toBeNull();

    rerender(
      <NewConfigWizard
        onCreate={vi.fn()}
        onCancel={vi.fn()}
        onTest={vi.fn()}
        testing={false}
        testResult={{ ok: false, message: "timeout" }}
      />,
    );
    expect(screen.getByText("Test failed. Error: timeout. Please check your network, API Key, and endpoint.")).toBeTruthy();
  });

  it("new custom: atomic saveCustomProvider then onCreate with custom ref", async () => {
    const saveSpy = vi.spyOn(cp, "saveCustomProvider").mockResolvedValue("newid");
    const onCreate = vi.fn();
    render(<NewConfigWizard onCreate={onCreate} onCancel={vi.fn()} onTest={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByText(/new custom provider/i));
    fireEvent.change(screen.getByPlaceholderText(/my custom provider/i), { target: { value: "Proxy" } });
    fireEvent.change(screen.getByPlaceholderText(/api\.example\.com/i), { target: { value: "https://proxy/v1" } });
    // ProviderModelList shows the "add custom model" action inline (no dropdown toggle).
    fireEvent.click(screen.getByText(/add custom model/i));
    // The add-model editor modal: locate its MODEL ID input.
    const idInput = screen.getByPlaceholderText(/^model id$/i);
    fireEvent.change(idInput, { target: { value: "my-model" } });
    // The modal's Save button: select by text+selector because happy-dom's
    // accessible-name computation is unreliable for the dialog's buttons.
    fireEvent.click(screen.getByText("Save", { selector: "button" }));
    // The API-key input: match by exact aria-label, NOT a loose /api key/i text
    // query (the BASE URL field's warning copy contains "API key", so a label
    // text match would grab the wrong input).
    const keyInput = (await screen.findAllByLabelText(/api key/i)).find(
      (e) => e.tagName === "INPUT" && e.getAttribute("aria-label") === "api key",
    )!;
    fireEvent.change(keyInput, { target: { value: "sk-x" } });
    fireEvent.click(screen.getByText("Create", { selector: "button" }));
    await waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Proxy",
          baseUrl: "https://proxy/v1",
          models: expect.arrayContaining([expect.objectContaining({ id: "my-model" })]),
        }),
      ),
    );
    expect(onCreate).toHaveBeenCalledWith("custom:newid", expect.objectContaining({ apiKey: "sk-x" }));
  });

  // #3: a configured custom provider is still editable from the dropdown; the
  // edit screen saves the provider patch in place — it must NOT show the
  // create-config form (a second createInstance would throw) nor call onCreate.
  it("edit configured custom: saves provider patch in place, no instance form", async () => {
    vi.spyOn(cp, "listCustomProviders").mockResolvedValue([
      { id: "cp1", name: "Proxy", baseUrl: "https://p/v1", models: [], createdAt: 0, updatedAt: 0 },
    ]);
    vi.spyOn(cp, "getInstancesUsingCustomProvider").mockResolvedValue([{ id: "i1", nickname: "x", model: "m" }]);
    const updSpy = vi.spyOn(cp, "updateCustomProvider").mockResolvedValue();
    const onCreate = vi.fn();
    const onCancel = vi.fn();
    render(
      <NewConfigWizard
        existingProviderRefs={["custom:cp1"]}
        onCreate={onCreate}
        onCancel={onCancel}
        onTest={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: /select provider/i });
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    await screen.findByText("Proxy");
    fireEvent.click(screen.getByRole("button", { name: /edit provider/i }));
    // Provider-level fields only — no API-key form for a configured provider.
    expect(screen.queryByLabelText("api key")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/my custom provider/i), { target: { value: "Proxy2" } });
    fireEvent.click(screen.getByText("Save", { selector: "button" }));
    await waitFor(() =>
      expect(updSpy).toHaveBeenCalledWith("cp1", expect.objectContaining({ name: "Proxy2" })),
    );
    expect(onCreate).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  // #3 residue: editing an UNCONFIGURED custom provider (the wizard edit screen
  // still shows the create-config InstanceForm) must render the entity's models
  // as EDITABLE custom rows — they used to ride the read-only fetched slot, and
  // dropping that slot must not leave this entry blank.
  it("edit unconfigured custom: entity models render as editable rows", async () => {
    vi.spyOn(cp, "listCustomProviders").mockResolvedValue([
      {
        id: "cp1", name: "Proxy", baseUrl: "https://p/v1",
        models: [{ id: "m-1", vision: false, tools: true, maxContextTokens: 8_000 }],
        createdAt: 0, updatedAt: 0,
      },
    ]);
    vi.spyOn(cp, "getInstancesUsingCustomProvider").mockResolvedValue([]);
    render(<NewConfigWizard onCreate={vi.fn()} onCancel={vi.fn()} onTest={vi.fn()} />);
    await screen.findByRole("button", { name: /select provider/i });
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    await screen.findByText("Proxy");
    fireEvent.click(screen.getByRole("button", { name: /edit provider/i }));
    await screen.findByText("m-1");
    expect(screen.getByLabelText("edit")).toBeTruthy();
    expect(screen.getByLabelText("remove")).toBeTruthy();
    expect(screen.getAllByText("m-1")).toHaveLength(1);
  });

  it("delete custom: blocks when instances depend on it", async () => {
    vi.spyOn(cp, "listCustomProviders").mockResolvedValue([
      { id: "cp1", name: "Proxy", baseUrl: "https://p/v1", models: [], createdAt: 0, updatedAt: 0 },
    ]);
    vi.spyOn(cp, "getInstancesUsingCustomProvider").mockResolvedValue([{ id: "i1", nickname: "x", model: "m" }]);
    const delSpy = vi.spyOn(cp, "deleteCustomProvider").mockResolvedValue();
    const alertSpy = vi.fn();
    vi.stubGlobal("alert", alertSpy);
    render(<NewConfigWizard onCreate={vi.fn()} onCancel={vi.fn()} onTest={vi.fn()} />);
    await screen.findByRole("button", { name: /select provider/i });
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    await screen.findByText("Proxy");
    fireEvent.click(screen.getByRole("button", { name: /delete provider/i }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(delSpy).not.toHaveBeenCalled();
  });
});
