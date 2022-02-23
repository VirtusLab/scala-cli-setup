# Scala CLI setup GitHub Action

A GitHub Action to install Scala CLI.

## Features

- run it on any platform: Linux, MacOS, Windows
- install [any JVM](https://get-coursier.io/docs/cli-java.html#jvm-index) you need
- setup the build tool of your choice: sbt, mill, seed, etc.
- install other common Scala CLI tools: Ammonite, Bloop, giter8, [etc.](https://github.com/coursier/apps/tree/master/apps/resources)

## Inputs

- `jvm` (optional): JVM to install
  - one of the options from `cs java --available`.
  - if left empty either the existing JVM will be used or Coursier will install its default JVM.
- `apps` (optional): Scala apps to install (`sbtn` by default)
  - space separated list of app names (from the [main channel](https://github.com/coursier/apps))

### Example with custom inputs

```yml
  steps:
    - uses: actions/checkout@v2
    - uses: VirtusLab/scala-cli-setup@main
      with:
        jvm: adopt:11
        apps: sbtn bloop ammonite
```

## Outputs

- `cs-version`: version of the installed Coursier (should be the latest available)
- `scala-cli-version`: version of the installed Scala CLI (should be the latest available)

## Caching

This action should work well with the official Coursier [cache-action](https://github.com/coursier/cache-action). For example:

```yml
  steps:
    - uses: actions/checkout@v2
    - uses: coursier/cache-action@v6
    - uses: VirtusLab/scala-cli-setup@main
```
