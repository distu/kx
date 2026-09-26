// Cria o projeto de exemplo usado pelos testes do instalador (portável: roda com o Node privado).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
mkdirSync(join(root, 'docs'), { recursive: true });
mkdirSync(join(root, 'src', 'resilience'), { recursive: true });
writeFileSync(join(root, 'README.md'), '# Demo\n\nServiço de pagamentos com retry e circuit breaker.\n');
writeFileSync(join(root, 'docs', 'runbook.md'), '# Runbook\n\nQuando o alerta disparar, verifique o disjuntor do gateway.\n');
writeFileSync(join(root, 'src', 'resilience', 'CircuitBreakerConfig.ts'), "export const STATE_OPEN = 'circuit-open';\nexport const THRESHOLD = 5;\n");
writeFileSync(join(root, '.env'), 'API_KEY=segredo\n');
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
git('init', '-q');
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
