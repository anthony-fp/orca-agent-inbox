// No build step: Orca strips the types and compiles the JSX when the panel loads.
import { Stack, Text } from 'orca'

export default function Panel() {
  return (
    <Stack gap="md">
      <Text muted>No agents tracked yet.</Text>
    </Stack>
  )
}
