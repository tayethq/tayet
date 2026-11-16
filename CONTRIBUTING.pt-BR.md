[English](CONTRIBUTING.md) · **Português (Brasil)**

# Como contribuir

Pull requests externos são bem-vindos desde o primeiro dia.

- **CLA.** Seu primeiro pull request exige a assinatura do [CLA](CLA.pt-BR.md) pelo cla-assistant.io.
- **Abra uma issue antes** de qualquer mudança grande, para combinarmos a abordagem antes de você
  construí-la.
- **`infra/deploy/`.** Nenhuma mudança sem uma issue.
- **CI.** O `ci.yml` roda typecheck, lint, testes e build por pacote, e precisa estar verde.
- **Língua.** Os commits são em inglês. Os comentários no código misturam português e inglês;
  comentários novos são em inglês.

Cada pacote é independente. Veja o [README](README.pt-BR.md#desenvolvimento) para o setup e o
[`SECURITY.pt-BR.md`](SECURITY.pt-BR.md) para reportar vulnerabilidades.

## Como um pull request entra

- O desenvolvimento acontece num repositório privado, e este repositório recebe um commit por
  release.
- Nada é commitado diretamente neste repositório fora de um release.
- Seu pull request é revisado aqui, depois aplicado ao repositório privado com a sua autoria mantida
  como `Co-authored-by`, e sai no release seguinte.
- Fechamos o seu pull request citando a tag desse release. Ele nunca é mergeado no GitHub.
- Baseie o seu trabalho na tag de release mais recente.
- Issues são bem-vindas em inglês ou em português.
