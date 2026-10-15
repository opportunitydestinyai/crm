---
impacto: nada_mudou
secao: corrigido
titulo: Atualização com o registro de imagens fora do ar não derruba mais a instalação
---

Clicar em **Atualizar** num momento em que a VPS não alcançava o registro de imagens (DNS saturado, rede instável) podia deixar o CRM fora do ar: o update parava os serviços, não conseguia baixar a versão nova, tentava construir as imagens na própria VPS, gastava a memória inteira dela e terminava com app, worker e proxy parados — 502 para todo mundo até alguém reiniciar o Docker à mão.

Agora, antes de parar qualquer coisa, o update confere se as quatro imagens da versão nova existem no registro. Se não existem, ou se o registro não responde, ele recusa sem começar (código 3) e a versão atual segue no ar, intocada. A construção local deixa de acontecer sozinha quando quem falhou é o registro; continua disponível de propósito, com `DESKCOMM_BUILD_LOCAL=1`.

Se a atualização falhar depois de trocar a versão — inclusive quando o app responde mas o worker, o agendador ou o proxy não sobem —, os pins de versão do `.env` voltam sozinhos para a versão anterior e os serviços sobem nela. O banco nunca é revertido. Toda execução deixa um resumo em `.deskcomm-update-diagnostico.log`, e o healthcheck passou a ter prazo, em vez de ficar preso em "▶ Containers" quando o Docker não responde.

Nada é preciso fazer na instalação: a mudança chega com a próxima atualização.

Contribuição de @webtecnica (#2208, fecha #1955).
