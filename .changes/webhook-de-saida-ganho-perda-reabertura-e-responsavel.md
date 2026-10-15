---
impacto: capacidade_nova
secao: adicionado
titulo: Webhook de saída ganha os gatilhos de ganho, perda, reabertura e troca de responsável
---

Quem liga o CRM a um ERP, ao faturamento ou a uma planilha de comissão agora recebe um evento quando um negócio é **ganho** ou **perdido**, quando um lead encerrado **reabre** e quando o **responsável muda** — e recebe o mesmo evento com o mesmo corpo em todo caminho que muda um negócio que já existe: arrastar o card, o botão Ganhou/Perdeu, o mover em lote, o fechamento da IA (`crm_close_demand`) ou o mover de uma automação. Antes, o arrasto emitia `lead.stage_changed` e o botão não disparava regra nenhuma: o fato era o mesmo e o webhook dependia do botão.

Limite conhecido: criar o negócio já numa etapa de ganho ou perda, ou já com responsável, **não** emite esses eventos — eles só nascem quando um negócio existente muda.

Os quatro gatilhos novos aparecem no seletor de automações com os campos de condição do próprio negócio. Neles, por ora, a automação não pode "Atribuir a um atendente" nem "Criar/mover lead no funil": a própria mudança dispararia a automação de novo, sem fim. O corpo da troca de responsável **não** leva UUID de usuário nenhum.

Duas mudanças aditivas valem também para quem já tem regras de negócio (`lead.created`, `lead.stage_changed`): o lead no corpo do webhook passa a trazer `lost_reason` e `closed_at`; e a opção "Incluir o responsável no corpo", que antes só valia em compromisso, passa a incluir o responsável do negócio (`owner`: `kind`, `id`, `name`). Quem valida o corpo com lista fechada de campos precisa aceitar os dois.
