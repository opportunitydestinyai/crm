/**
 * "O que cada nível pode fazer" — a explicação que faltava na Equipe.
 *
 * Os quatro níveis (Somente leitura, Atendente, Gerente, Administrador) já existem e
 * já são cobrados pelo servidor em toda rota (`requireRole`). O que não existia era
 * dizer, em português, o que cada um enxerga e muda. As frases abaixo vêm do que as
 * rotas exigem hoje (mínimo de papel por área), e quem as escreve é a página — este
 * componente só desenha o que recebe, já traduzido.
 */
export interface NivelDeAcesso {
  id: string;
  nome: string;
  apelido: string;
  pode: string;
  naoPode: string;
}

export function NiveisDeAcesso({
  titulo,
  resumo,
  niveis,
  rodape,
}: {
  titulo: string;
  resumo: string;
  niveis: NivelDeAcesso[];
  rodape: string;
}) {
  return (
    <details className="group rounded-lg border" data-testid="niveis-de-acesso">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
        <span>
          {titulo} <span className="font-normal text-muted-foreground">— {resumo}</span>
        </span>
        <span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="space-y-3 border-t px-4 py-4">
        <ul className="grid gap-3 md:grid-cols-2">
          {niveis.map((n) => (
            <li key={n.id} className="rounded-md border p-3 text-sm">
              <p className="font-medium">
                {n.nome} <span className="text-xs font-normal text-muted-foreground">{n.apelido}</span>
              </p>
              <p className="mt-2 text-xs">
                <span className="font-medium text-success-fg">✓ </span>
                {n.pode}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                <span className="font-medium">✕ </span>
                {n.naoPode}
              </p>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{rodape}</p>
      </div>
    </details>
  );
}
