// Índice inicial de uma sessão do export Megolm. O JSON do export NÃO carrega um campo
// `first_known_index` em claro — o índice vive nos bytes iniciais do blob `session_key`
// (formato de export Megolm: 1 byte de versão + índice u32 big-endian + resto do
// ratchet), decodificação provada no spike C1/C2 (export real devolveu
// `{"export_version_byte":1,"first_known_index":0}` para membro presente ao nascimento).
//
// O filtro de depósito (ADR-057 dec. 2) depende disto: índice 0 = sessão recebida no
// NASCIMENTO (cobertura íntegra → deposita); índice N>0 = sessão recebida mid-ratchet
// (sala anterior à entrada do cofre — Megolm não anda para trás, o material não cobre
// as mensagens 0..N-1 → pula). Blob indecodificável devolve null: nunca depositar o que
// não se sabe ler (o chamador trata null como pulo, com sinal).

export function firstKnownIndexOf(sessionKeyB64: string): number | null {
  if (sessionKeyB64.length === 0) return null
  const blob = Buffer.from(sessionKeyB64, 'base64')
  // 1 byte de versão + 4 de índice; menos que isso não é um export Megolm.
  if (blob.length < 5) return null
  return blob.readUInt32BE(1)
}
