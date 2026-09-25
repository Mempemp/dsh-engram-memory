// Проверки самодостаточности пакета: плагин сам раскладывает MCP-половину в
// харнесс и сам объявляет сервер — один раз, ничего не переписывая у человека.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentProjectFile, ensureMcpPackage, ensureMcpServer, harnessDir, mcpVersion, readCurrentProject, resolveNode, setupMcp, writeCurrentProject } from '../lib/mcp-setup.js'

let failed = 0
function check(title, ok, extra = '') {
  if (ok) console.log(`ок: ${title}`)
  else {
    failed += 1
    console.error(`FAIL ${title}${extra === '' ? '' : ` — ${extra}`}`)
  }
}

// Фикстура: «пакет плагина» с крошечными подделками engram.exe и прокладки.
const root = mkdtempSync(join(tmpdir(), 'engram-mcp-setup-'))
const plugin = join(root, 'plugin')
const bundled = join(plugin, 'mcp')
mkdirSync(join(bundled, 'bin'), { recursive: true })
writeFileSync(join(bundled, 'engram.exe'), 'fake-binary')
writeFileSync(join(bundled, 'bin', 'engram-mcp.js'), '// shim')
writeFileSync(join(bundled, 'VERSION'), '2.1.0\n')
const harness = join(root, 'harness')
mkdirSync(harness, { recursive: true })
const packageDir = join(harness, 'mcp', 'engram', 'package')

console.log('== раскладка MCP-половины ==')
check('версия читается из маркера', mcpVersion(bundled) === '2.1.0', mcpVersion(bundled))
const first = ensureMcpPackage(harness, bundled)
check('половина разложена', first.action === 'copied' && existsSync(join(packageDir, 'engram.exe')), first.action)
check('прокладка легла рядом с engram.exe', existsSync(join(packageDir, 'bin', 'engram-mcp.js')))
check('версия отмечена в копии', mcpVersion(packageDir) === '2.1.0')
check('повторный запуск ничего не копирует', ensureMcpPackage(harness, bundled).action === 'current')

writeFileSync(join(bundled, 'VERSION'), '2.2.0\n')
const upgraded = ensureMcpPackage(harness, bundled)
check('новая версия в пакете заменяет копию', upgraded.action === 'copied' && mcpVersion(packageDir) === '2.2.0')

// Прокладка меняется чаще engram.exe: её копию сверяем по содержимому, иначе
// правка осталась бы в пакете и не доехала до харнесса.
writeFileSync(join(bundled, 'bin', 'engram-mcp.js'), '// shim v2')
const shimOnly = ensureMcpPackage(harness, bundled)
check('правка прокладки доезжает без смены версии', shimOnly.action === 'copied' && readFileSync(join(packageDir, 'bin', 'engram-mcp.js'), 'utf8') === '// shim v2', shimOnly.action)
check('и после правки повтор ничего не копирует', ensureMcpPackage(harness, bundled).action === 'current')

console.log('\n== снимок «где работаем» ==')
const env = { LOCALAPPDATA: join(root, 'localappdata') }
check('путь снимка — в LocalAppData', currentProjectFile(env) === join(env.LOCALAPPDATA, 'DSH-1C', 'engram-current-project.json'), String(currentProjectFile(env)))
check('без LocalAppData снимка нет', currentProjectFile({}) === null && writeCurrentProject('hrm1', 'D:/Work/hrm1', {}) === null && readCurrentProject({}) === null)
check('снимок пишется и читается', writeCurrentProject('hrm1', 'D:/Work/hrm1', env) !== null && readCurrentProject(env) === 'hrm1')
check('пустое имя проекта не пишется', writeCurrentProject('   ', 'D:/Work/hrm1', env) === null && readCurrentProject(env) === 'hrm1')
writeFileSync(currentProjectFile(env), 'не json')
check('битый снимок — проекта нет', readCurrentProject(env) === null)
writeCurrentProject('hrm1', 'D:/Work/hrm1', env)

console.log('\n== прокладка читает снимок и конфиг ==')
const shim = await import('../mcp/bin/engram-mcp.js')
check('проект берётся из снимка', shim.projectFromState([currentProjectFile(env)]) === 'hrm1', String(shim.projectFromState([currentProjectFile(env)])))
check('нет файла — проекта нет', shim.projectFromState([join(root, 'нет-такого.json'), undefined, '']) === null)

console.log('\n== прокладка называет проект в записях ==')
const writeCall = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mem_save', arguments: { title: 'x', content: 'y' } } })
const injected = JSON.parse(shim.injectProject(writeCall, 'hrm1'))
check('проект подставлен в запись', injected.params.arguments.project === 'hrm1' && injected.params.arguments.title === 'x', shim.injectProject(writeCall, 'hrm1'))
const namedCall = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mem_save', arguments: { project: 'pixerartist', content: 'y' } } })
check('названный проект не перебивается', JSON.parse(shim.injectProject(namedCall, 'hrm1')).params.arguments.project === 'pixerartist')
const searchCall = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mem_search', arguments: { query: 'x' } } })
check('поиск проектом не сужается', shim.injectProject(searchCall, 'hrm1') === searchCall)
const listCall = JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
check('служебные сообщения проходят как есть', shim.injectProject(listCall, 'hrm1') === listCall)
check('строка не из JSON проходит как есть', shim.injectProject('не json', 'hrm1') === 'не json')
check('без проекта строка не меняется', shim.injectProject(writeCall, null) === writeCall && shim.injectProject(writeCall, '') === writeCall)
const shimSource = readFileSync(new URL('../mcp/bin/engram-mcp.js', import.meta.url), 'utf8')
check('снимок читается на каждый вызов, а не один раз при запуске', shimSource.includes('injectProject(line, projectNow())'), 'в прокладке нет чтения снимка на вызов')
const shimConfig = join(root, 'shim-config.json')
writeFileSync(shimConfig, JSON.stringify({ dataDir: 'D:/data' }), 'utf8')
check('конфиг читается первым существующим путём', shim.readConfig([join(root, 'нет-такого.json'), shimConfig])?.dataDir === 'D:/data')
check('конфига нет — пустой объект', JSON.stringify(shim.readConfig([join(root, 'нет-такого.json')])) === '{}')

console.log('\n== объявление сервера ==')
const shimPath = join(packageDir, 'bin', 'engram-mcp.js')
check('сервер объявлен', ensureMcpServer(harness, { nodePath: 'C:/node/node.exe', shimPath }).action === 'added')
const configPath = join(harness, 'dsh-mcp.json')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const entry = config.servers[0]
check(
  'запись полная и включена',
  entry.name === 'engram' && entry.transport === 'stdio' && entry.command === 'C:/node/node.exe' && entry.args[0] === shimPath && entry.enabled === true,
  JSON.stringify(entry)
)
const before = readFileSync(configPath, 'utf8')
check('повтор ничего не меняет', ensureMcpServer(harness, { nodePath: 'другой', shimPath: 'другой' }).action === 'present' && readFileSync(configPath, 'utf8') === before)

writeFileSync(
  configPath,
  JSON.stringify({ version: 1, servers: [{ name: 'engram', transport: 'stdio', command: 'C:/mine/node.exe', args: ['C:/mine/shim.js'], enabled: false }] }, null, 2)
)
const mine = readFileSync(configPath, 'utf8')
check('настройка человека не переписывается', ensureMcpServer(harness, { nodePath: 'чужой', shimPath: 'чужой' }).action === 'present' && readFileSync(configPath, 'utf8') === mine)
check('и в ней не появилось наших путей', !readFileSync(configPath, 'utf8').includes('чужой'))

writeFileSync(configPath, JSON.stringify({ version: 1, servers: [{ name: 'rlm', transport: 'streamable-http', url: 'http://127.0.0.1:9330/mcp' }] }, null, 2))
check('к чужому конфигу сервер добавляется', ensureMcpServer(harness, { nodePath: 'n', shimPath: 's' }).action === 'added')
check('бэкап конфига сделан', readdirSync(harness).some((file) => file.startsWith('dsh-mcp.json.bak-')), readdirSync(harness).join(', '))
const merged = JSON.parse(readFileSync(configPath, 'utf8'))
check('чужой сервер на месте', merged.servers.length === 2 && merged.servers[0].name === 'rlm' && merged.servers[1].name === 'engram')

console.log('\n== выключатели и поиск каталогов ==')
check('registerMcp: false — тихий отказ', setupMcp({ registerMcp: false }, { pluginDir: plugin }).action === 'disabled')
check('без харнесса — тихий no-op', setupMcp({}, { pluginDir: plugin, env: {} }).action === 'no-harness')
check('каталог харнесса из APPDATA', harnessDir({}, { APPDATA: 'C:/Users/u/AppData/Roaming' }) === join('C:/Users/u/AppData/Roaming', 'dsh-desktop', 'harness'))
check('DSH_HOME важнее APPDATA', harnessDir({}, { DSH_HOME: 'D:/harness', APPDATA: 'C:/x' }) === 'D:/harness')
check('настройка важнее всего', harnessDir({ harnessDir: 'D:/mine' }, { DSH_HOME: 'D:/harness' }) === 'D:/mine')
check('узел берётся из своей установки', resolveNode({}, { execPath: 'C:/dsh/node.exe' }) === 'C:/dsh/node.exe')
check('узел можно задать настройкой', resolveNode({ nodePath: 'C:/custom/node.exe' }, { execPath: 'C:/DSH Desktop.exe' }) === 'C:/custom/node.exe')

console.log('\n== полный проход ==')
const freshHarness = join(root, 'harness-full')
mkdirSync(freshHarness, { recursive: true })
const full = setupMcp({}, { pluginDir: plugin, env: { DSH_HOME: freshHarness }, execPath: 'C:/dsh/node.exe' })
check('полный проход раскладывает половину и объявляет сервер', full.server.action === 'added' && full.package.action === 'copied', JSON.stringify(full))
check('на втором проходе — ничего', setupMcp({}, { pluginDir: plugin, env: { DSH_HOME: freshHarness }, execPath: 'C:/dsh/node.exe' }).server.action === 'present')

console.log(failed === 0 ? '\nвсе проверки прошли' : `\nпровалено проверок: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
