**English** · [Português (Brasil)](CONTRIBUTING.pt-BR.md)

# Contributing

External pull requests are welcome from day zero.

- **CLA.** Your first pull request requires signing the [CLA](CLA.md) through cla-assistant.io.
- **Open an issue first** for any large change, so we can agree on the approach before you build it.
- **`infra/deploy/`.** No changes without an issue.
- **CI.** `ci.yml` runs typecheck, lint, tests and build per package, and must be green.
- **Language.** Commits are in English. Code comments are a mix of Portuguese and English; new
  comments are in English.

Each package is standalone. See the [README](README.md#development) for setup, and
[`SECURITY.md`](SECURITY.md) for vulnerability reports.

## How pull requests land

- Development happens in a private repository, and this repository receives one commit per release.
- Nothing is ever committed directly to this repository outside a release.
- Your pull request is reviewed here, then applied to the private repository with your authorship
  kept as `Co-authored-by`, and ships in the next release.
- We close your pull request referencing that release tag. It is never merged on GitHub.
- Base your work on the latest release tag.
- Issues are welcome in English or Portuguese.
