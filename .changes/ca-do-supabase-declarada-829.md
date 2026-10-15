---
impacto: capacidade_nova
secao: adicionado
titulo: A CA do Supabase pode ser declarada uma vez no .env, e o diagnóstico passa a testar o TLS do banco
---

Quem exige verificação de certificado na conexão com o banco do Supabase agora declara uma linha no `.env`: `SUPABASE_SSL_ROOT_CERT=/root/certs/prod-ca-2021.crt`. Com o arquivo existindo, o kit o monta somente leitura no app, no worker, no agendador (onde o Node soma a CA à confiança) e nos psql temporários de instalação, atualização e backup. O `healthcheck.sh` ganhou o passo "TLS do banco", que testa a conexão com verificação total da cadeia e do nome do servidor.

Sem a linha, o app, o worker e os psql funcionam como antes. O healthcheck mostra uma linha informativa dizendo que a chave é opcional, sem aviso e sem pedir download nenhum; no single-server ele diz que o passo não se aplica. A verificação de certificado nunca é desligada.

Para quem declara a CA: nos psql do kit, uma connection string com `sslmode=require` passa a verificar a cadeia, porque a libpq trata `require` como `verify-ca` quando há uma CA. Uma CA errada faz a instalação, a atualização e o backup falharem fechado. Sem `sslmode` na string, nada muda.

O diagnóstico da connection string no `install.sh` também passou a explicar a falha de certificado com o nome da variável, sem confundir senha errada ou queda de rede com problema de certificado.

Contribuição de @webtecnica (#2215, fecha #829).
