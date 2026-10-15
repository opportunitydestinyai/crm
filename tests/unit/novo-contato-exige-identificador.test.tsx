import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => ({ country: "BR" }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));
vi.mock("@/hooks/contacts/useCreateContact", () => ({
  useCreateContact: () => ({ mutateAsync: create, isPending: false }),
}));
import { NewContactDialog } from "@/components/contacts/NewContactDialog";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("novo contato manual exige email ou telefone", () => {
  it.each(["", "   "])("recusa identificadores vazios (%j), mesmo com nome", async (value) => {
    const user = userEvent.setup();
    const close = vi.fn();
    render(<NewContactDialog open onOpenChange={close} nomeInicial="Teste" />);
    if (value) await user.type(screen.getByLabelText("Telefone (E.164)"), value);
    await user.click(screen.getByRole("button", { name: "Criar contato" }));
    await waitFor(() => expect(screen.getAllByText("Preencha pelo menos um identificador (email ou telefone).")).toHaveLength(2));
    expect(create).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
  it.each([["Email", "qa@example.com", "email"], ["Telefone (E.164)", "+390212345678", "phone_number"]])(
    "aceita %s sem exigir o outro identificador", async (label, value, field) => {
      create.mockResolvedValue({ data: { contact: { id: "synthetic" } } });
      const user = userEvent.setup();
      const close = vi.fn();
      render(<NewContactDialog open onOpenChange={close} />);
      await user.type(screen.getByLabelText(label), value);
      await user.click(screen.getByRole("button", { name: "Criar contato" }));
      await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ [field]: value })));
      expect(close).toHaveBeenCalledWith(false);
    },
  );
});
