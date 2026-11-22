import vine from '@vinejs/vine'

export const fieldManualEditionValidator = vine.compile(
  vine.object({
    edition: vine.enum(['zim', 'full'] as const),
  })
)

export const fieldManualSearchValidator = vine.compile(
  vine.object({
    q: vine.string().trim().maxLength(200).optional(),
    family: vine.string().trim().maxLength(120).optional(),
    branch: vine.string().trim().maxLength(80).optional(),
    pub_type: vine.string().trim().maxLength(80).optional(),
    offset: vine.number().min(0).optional(),
    limit: vine.number().min(1).max(100).optional(),
  })
)

export const fieldManualOpenValidator = vine.compile(
  vine.object({
    params: vine.object({
      id: vine.string().trim().minLength(1).maxLength(300),
    }),
    format: vine.enum(['pdf', 'epub', 'md'] as const),
  })
)
