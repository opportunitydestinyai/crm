/**
 * Capacidades do CANAL DE CONECTORES MCP: o agente usa o servidor MCP da plataforma
 * que a empresa já tem (sistema da academia, ERP, agenda). Genérico: não nomeia
 * nenhum sistema. Os nomes `crm_*` são contrato de wire (ver `dados-externos.ts`).
 */
import { declararTools } from "./tipos";

export const TOOLS_MCP_EXTERNO = declararTools([
  {
    name: "crm_list_external_mcp_tools",
    category: "read",
    rotulo: "Ver o que o sistema conectado oferece",
    explicacao:
      "Mostra as ferramentas que o sistema da sua empresa, que você conectou, deixa o assistente usar, para ele saber o que consegue consultar ou registrar.",
    oQueToca: "Sistema conectado da empresa",
    risco: "seguro",
    pacotes: ["organizar"],
  },
  {
    name: "crm_call_external_mcp_tool",
    category: "write",
    rotulo: "Usar o sistema conectado",
    explicacao:
      "Executa uma ferramenta do sistema da sua empresa que você conectou, como consultar o histórico de um cliente ou registrar uma aula. Pode alterar dados nesse sistema.",
    oQueToca: "Sistema conectado da empresa",
    risco: "atencao",
    pacotes: ["organizar"],
  },
]);
