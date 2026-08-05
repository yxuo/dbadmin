# Gerar VSIX (instalar localmente)

Este guia mostra como empacotar a extensão em um arquivo VSIX e instalar no VS Code.

## Pré-requisitos

- Node.js e npm instalados
- Dependências do projeto instaladas

## 1 Instalar dependências

```bash
npm install
```

## 2 Compilar a extensão

```bash
npm run compile
```

## 3 Gerar o VSIX

Comando padrão:

```bash
npx @vscode/vsce package --out dbadmin-0.0.1.vsix
```

Neste projeto, o `vsce` pode pedir confirmação por avisos de manifesto. Para automação local, use:

```bash
"y" | npx @vscode/vsce package --allow-missing-repository --allow-star-activation --out dbadmin-0.0.1.vsix
```

## 4 Instalar no VS Code

Via CLI:

```bash
code --install-extension .\\dbadmin-0.0.1.vsix --force
```

Via interface:

1. Abra Extensions no VS Code.
2. Clique em `...` (menu da view).
3. Selecione `Install from VSIX...`.
4. Escolha o arquivo VSIX gerado.

## 5 Atualizar versão local

Ao gerar novas builds locais:

- Reexecute `npm run compile`
- Reexecute `vsce package`
- Reinstale com `--force`

## Dicas

- O conteúdo do pacote pode ser inspecionado com:

```bash
npx @vscode/vsce ls
```

- Se o pacote ficar grande, revise o arquivo `.vscodeignore`.
