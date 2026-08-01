import { resolve } from 'node:path';

export interface McpBootOptions {
  projectRoot?: string;
  strictProjectRoot: boolean;
}

export function parseMcpBootOptions(
  args: string[],
  envProjectRoot = process.env.KX_PROJECT_ROOT,
): McpBootOptions {
  let projectRoot: string | undefined;
  let legacyCwd: string | undefined;
  let strictProjectRoot = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--strict-project-root') {
      if (strictProjectRoot) throw new Error('--strict-project-root foi informado mais de uma vez.');
      strictProjectRoot = true;
      continue;
    }

    const parseValue = (name: '--project-root' | '--cwd'): string | null => {
      if (arg === name) {
        const value = args[i + 1];
        if (!value || value.startsWith('--')) throw new Error(`${name} exige um diretório.`);
        i += 1;
        return value;
      }
      const prefix = `${name}=`;
      return arg.startsWith(prefix) ? arg.slice(prefix.length) : null;
    };

    const explicit = parseValue('--project-root');
    if (explicit !== null) {
      if (!explicit || projectRoot) throw new Error('--project-root deve ser informado uma única vez.');
      projectRoot = explicit;
      continue;
    }

    const cwd = parseValue('--cwd');
    if (cwd !== null) {
      if (!cwd || legacyCwd) throw new Error('--cwd deve ser informado uma única vez.');
      legacyCwd = cwd;
      continue;
    }

    throw new Error(`Opção MCP desconhecida: ${arg}`);
  }

  if (projectRoot && legacyCwd && resolve(projectRoot) !== resolve(legacyCwd)) {
    throw new Error('--project-root e --cwd apontam para raízes diferentes.');
  }

  const explicitRoot = projectRoot || legacyCwd || envProjectRoot;
  if (strictProjectRoot && !explicitRoot) {
    throw new Error('Modo MCP estrito exige --project-root, --cwd ou KX_PROJECT_ROOT.');
  }

  return {
    projectRoot: explicitRoot ? resolve(explicitRoot) : undefined,
    strictProjectRoot,
  };
}
