import * as cli from '@actions/exec'
import * as core from '@actions/core'
import * as os from 'os'
import * as path from 'path'
import * as tc from '@actions/tool-cache'

const scalaCLIVersion = '1.1.1'

const architecture_x86_64 = 'x86_64'
const architecture_aarch64 = 'aarch64'

const architecture = getArchitecture()

const csDefaultVersion_x86_64 = '2.1.7'
const csDefaultVersion_aarch64 = '2.1.7'

const csVersion =
  core.getInput('version') ||
  (architecture === architecture_x86_64 ? csDefaultVersion_x86_64 : csDefaultVersion_aarch64)

const coursierVersionSpec = csVersion

const coursierBinariesGithubRepository =
  architecture === architecture_x86_64
    ? 'https://github.com/coursier/coursier/'
    : 'https://github.com/VirtusLab/coursier-m1/'

function getArchitecture(): string {
  if (process.arch === 'x64') {
    return architecture_x86_64
  } else if (process.arch === 'arm' || process.arch === 'arm64') {
    return architecture_aarch64
  } else {
    throw new Error(`Coursier does not have support for the ${process.arch} architecture`)
  }
}

async function execOutput(cmd: string, ...args: string[]): Promise<string> {
  let output = ''
  const options = {
    listeners: {
      stdout: (data: Buffer) => {
        output += data.toString()
      },
    },
  }
  await cli.exec(cmd, args.filter(Boolean), options)
  return output.trim()
}

async function downloadCoursier(): Promise<string> {
  const baseUrl = `${coursierBinariesGithubRepository}/releases/download/v${csVersion}/cs-${architecture}`
  let csBinary = ''
  switch (process.platform) {
    case 'linux': {
      const guid = await tc.downloadTool(`${baseUrl}-pc-linux.gz`)
      const arc = `${guid}.gz`
      await cli.exec('mv', [guid, arc])
      csBinary = arc
      break
    }
    case 'darwin': {
      const guid = await tc.downloadTool(`${baseUrl}-apple-darwin.gz`)
      const arc = `${guid}.gz`
      await cli.exec('mv', [guid, arc])
      csBinary = arc
      break
    }
    case 'win32': {
      const guid = await tc.downloadTool(`${baseUrl}-pc-win32.zip`)
      const arc = `${guid}.zip`
      await cli.exec('mv', [guid, arc])
      csBinary = arc
      break
    }
    default:
      core.setFailed(`Unknown process.platform: ${process.platform}`)
  }
  if (!csBinary) core.setFailed(`Couldn't download Coursier`)
  if (csBinary.endsWith('.gz')) {
    await cli.exec('gzip', ['-d', csBinary])
    csBinary = csBinary.slice(0, csBinary.length - '.gz'.length)
  }
  if (csBinary.endsWith('.zip')) {
    const destDir = csBinary.slice(0, csBinary.length - '.zip'.length)
    await cli.exec('unzip', ['-j', csBinary, 'cs-x86_64-pc-win32.exe', '-d', destDir])
    csBinary = `${destDir}\\cs-x86_64-pc-win32.exe`
  }
  await cli.exec('chmod', ['+x', csBinary])
  return csBinary
}

async function cs(...args: string[]): Promise<string> {
  const previous = tc.find('cs', coursierVersionSpec)
  if (previous) {
    core.addPath(previous)
  } else {
    const csBinary = await downloadCoursier()
    const binaryName = process.platform === 'win32' ? 'cs.exe' : 'cs'
    const csCached = await tc.cacheFile(csBinary, binaryName, 'cs', csVersion)
    core.addPath(csCached)
  }
  return execOutput('cs', ...args)
}

async function run(): Promise<void> {
  try {
    await core.group('Install Coursier', async () => {
      await cs('--help')
      core.setOutput('cs-version', csVersion)
    })

    await core.group('Install JVM', async () => {
      const jvmInput = core.getInput('jvm')
      const jvmArg = jvmInput ? ['--jvm', jvmInput] : []
      if (!jvmInput && process.env.JAVA_HOME) {
        core.info(`skipping, JVM is already installed in ${process.env.JAVA_HOME}`)
      } else {
        await cs('java', ...jvmArg, '-version')
        const csJavaHome = await cs('java-home', ...jvmArg)
        core.exportVariable('JAVA_HOME', csJavaHome)
        core.addPath(path.join(csJavaHome, 'bin'))
      }
    })

    await core.group('Install Apps', async () => {
      const value = core.getInput('apps').trim()
      const apps: string[] = value.split(' ')
      const scalaCLIVersionInput = core.getInput('scala-cli-version')
      let version
      if (scalaCLIVersionInput) {
        if (scalaCLIVersionInput === 'latest') {
          version = ''
        } else {
          version = scalaCLIVersionInput
        }
      } else {
        version = scalaCLIVersion
      }
      apps.push(`scala-cli${version ? `:${version}` : ''}`)
      if (value && apps.length) {
        if (process.env.COURSIER_BIN_DIR) {
          core.info(
            `Using the cs bin directory from COURSIER_BIN_DIR: ${process.env.COURSIER_BIN_DIR}`,
          )
          core.addPath(process.env.COURSIER_BIN_DIR)
        } else {
          const coursierBinDir = path.join(os.homedir(), 'cs', 'bin')
          core.info(`Setting COURSIER_BIN_DIR to: ${coursierBinDir}`)
          core.exportVariable('COURSIER_BIN_DIR', coursierBinDir)
          core.addPath(coursierBinDir)
        }
        await cs('install', '--contrib', ...apps)
        core.setOutput(
          'scala-cli-version',
          await execOutput('scala-cli', 'version', '--cli-version'),
        )
      }
    })
    await core.group('Config --power', async () => {
      const powerInput = core.getInput('power').trim()
      const isPower = powerInput === 'true'
      if (isPower) {
        await execOutput('scala-cli', 'config', 'power', 'true')
      }
    })
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    core.setFailed(msg)
  }
}

run()
