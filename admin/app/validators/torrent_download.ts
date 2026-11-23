import vine from '@vinejs/vine'

export const torrentSourceValidator = vine.compile(
  vine.object({
    source: vine.string().trim().minLength(1).maxLength(8192),
  })
)

export const torrentIdValidator = vine.compile(
  vine.object({
    params: vine.object({
      id: vine.string().trim().regex(/^[a-f0-9]{16}$/),
    }),
  })
)
