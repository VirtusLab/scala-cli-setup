import * as cli from '@actions/exec'
import * as core from '@actions/core'
import * as os from 'os'
import * as path from 'path'
import * as tc from '@actions/tool-cache'

const scalaCLIVersion = '1.19.0'

const architecture_x86_64 = 'x86_64'
const architecture_aarch64 = 'aarch64'

const architecture = getArchitecture()

const csDefaultVersion = '2.1.26'
const csVersion = core.getInput('version') || csDefaultVersion

const coursierVersionSpec = csVersion

function isVersionAtLeast(version: string, targetVersion: string): boolean {
  // Remove any milestone/RC suffix (e.g., "2.1.25-M19" -> "2.1.25")
  const baseVersion = version.split('-')[0]
  const baseTargetVersion = targetVersion.split('-')[0]

  const parts = baseVersion.split('.').map(Number)
  const targetParts = baseTargetVersion.split('.').map(Number)

  const major = parts[0] || 0
  const minor = parts[1] || 0
  const patch = parts[2] || 0

  const targetMajor = targetParts[0] || 0
  const targetMinor = targetParts[1] || 0
  const targetPatch = targetParts[2] || 0

  if (major > targetMajor) return true
  if (major < targetMajor) return false
  if (minor > targetMinor) return true
  if (minor < targetMinor) return false
  return patch >= targetPatch
}

// Like isVersionAtLeast, but also compares milestones of the same base version
// (e.g. "2.1.25-M25" < "2.1.25-M26" < "2.1.25"). Unrecognised suffixes don't satisfy it.
function isVersionWithMilestoneAtLeast(version: string, targetVersion: string): boolean {
  if (!isVersionAtLeast(version, targetVersion)) return false
  if (!isVersionAtLeast(targetVersion, version)) return true // strictly newer base version
  const milestone = (v: string): number => {
    const suffix = v.split('-').slice(1).join('-')
    if (!suffix) return Number.POSITIVE_INFINITY // a final release comes after all its milestones
    const match = /^M(\d+)$/.exec(suffix)
    return match ? Number(match[1]) : Number.NaN
  }
  return milestone(version) >= milestone(targetVersion)
}

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

// The first Windows 11 build. Earlier Windows builds on ARM64 (Windows 10) can't emulate x64.
const windows11FirstBuild = 22000

function isWindowsArmWithoutX64Emulation(): boolean {
  if (process.platform !== 'win32' || architecture !== architecture_aarch64) return false
  // os.release() returns e.g. '10.0.22631' on Windows
  const build = Number(os.release().split('.')[2])
  return !Number.isNaN(build) && build < windows11FirstBuild
}

// Coursier doesn't publish a native launcher for Windows ARM64, only a JVM-based app image.
// On Windows 11 ARM, we use the x86_64 native launcher, which runs via x64 emulation.
// On Windows 10 ARM, which can't emulate x64, we fall back to the ARM64 JVM-based app image.
const useCoursierJvmAppImage = isWindowsArmWithoutX64Emulation()
const coursierArchitecture =
  process.platform === 'win32' && !useCoursierJvmAppImage ? architecture_x86_64 : architecture

const coursierBinariesGithubRepository = isVersionAtLeast(csVersion, '2.1.25')
  ? 'https://github.com/coursier/coursier/'
  : coursierArchitecture === architecture_x86_64
    ? 'https://github.com/coursier/coursier/'
    : 'https://github.com/VirtusLab/coursier-m1/'

async function downloadCoursier(): Promise<string> {
  const baseUrl = `${coursierBinariesGithubRepository}/releases/download/v${csVersion}/cs-${coursierArchitecture}`
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
    const exeName = `cs-${coursierArchitecture}-pc-win32.exe`
    await cli.exec('unzip', ['-j', csBinary, exeName, '-d', destDir])
    csBinary = `${destDir}\\${exeName}`
  }
  await cli.exec('chmod', ['+x', csBinary])
  return csBinary
}

// The first Coursier version publishing the Windows ARM64 JVM-based app image.
const coursierWindowsArmJvmAppImageMinVersion = '2.1.25-M26'

// The JVM-based app image is a whole directory (cs.exe, app/, runtime/), so it has to be kept together.
async function downloadCoursierJvmAppImage(): Promise<string> {
  if (!isVersionWithMilestoneAtLeast(csVersion, coursierWindowsArmJvmAppImageMinVersion)) {
    throw new Error(
      `Coursier ${csVersion} doesn't support Windows ARM64 without x64 emulation (${os.release()}). ` +
        `Use Coursier ${coursierWindowsArmJvmAppImageMinVersion} or newer (the 'version' input), or Windows 11.`,
    )
  }
  const baseUrl = `${coursierBinariesGithubRepository}/releases/download/v${csVersion}/cs-${coursierArchitecture}`
  const guid = await tc.downloadTool(`${baseUrl}-pc-win32-jvm.zip`)
  const arc = `${guid}.zip`
  await cli.exec('mv', [guid, arc])
  return tc.extractZip(arc)
}

async function cs(...args: string[]): Promise<string> {
  const previous = tc.find('cs', coursierVersionSpec)
  if (previous) {
    core.addPath(previous)
  } else if (useCoursierJvmAppImage) {
    core.info(
      `Windows ARM64 without x64 emulation detected (${os.release()}), using the JVM-based Coursier launcher`,
    )
    const csDir = await downloadCoursierJvmAppImage()
    const csCached = await tc.cacheDir(csDir, 'cs', csVersion)
    core.addPath(csCached)
  } else {
    const csBinary = await downloadCoursier()
    const binaryName = process.platform === 'win32' ? 'cs.exe' : 'cs'
    const csCached = await tc.cacheFile(csBinary, binaryName, 'cs', csVersion)
    core.addPath(csCached)
  }
  return execOutput('cs', ...args)
}

// On Windows 11 ARM64, cs is the x86_64 launcher running under emulation, so it'd pick x64 JVMs by default,
// which would then run emulated (and much slower) as well. Ask for arm64 JVMs explicitly instead.
// (The JVM-based cs used on Windows 10 ARM64 is an arm64 process, so it picks arm64 JVMs by itself.)
const preferArm64Jvm =
  process.platform === 'win32' && architecture === architecture_aarch64 && !useCoursierJvmAppImage

async function installJvm(jvmArg: string[]): Promise<string> {
  if (preferArm64Jvm) {
    const arm64Arg = ['--architecture', 'arm64']
    try {
      await cs('java', ...jvmArg, ...arm64Arg, '-version')
      return await cs('java-home', ...jvmArg, ...arm64Arg)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      const jvmName = jvmArg[1] ?? 'the default JVM'
      core.warning(
        `Couldn't install an arm64 build of ${jvmName} (${msg}), falling back to x64, which runs via emulation ` +
          `and is considerably slower. Pick a JVM with Windows arm64 builds to avoid it ` +
          `(e.g. zulu:17, microsoft-openjdk:17, temurin:21).`,
      )
    }
  }
  await cs('java', ...jvmArg, '-version')
  return cs('java-home', ...jvmArg)
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
        const csJavaHome = await installJvm(jvmArg)
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

void run()
