import standardConfig from 'eslint-config-standard-kit'
import rnPlugin from 'eslint-plugin-react-native'

import edgePlugin from './scripts/eslint-plugin-edge/index.mjs'

export default [
  ...standardConfig({
    prettier: true,
    sortImports: true,
    node: true,
    typescript: true
  }),

  // Global ignores need to be in their own block:
  {
    ignores: [
      'lib/*',
    ]
  }
]
