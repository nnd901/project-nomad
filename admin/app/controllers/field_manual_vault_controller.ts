import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import { FieldManualVaultService } from '#services/field_manual_vault_service'
import {
  fieldManualEditionValidator,
  fieldManualOpenValidator,
  fieldManualSearchValidator,
} from '#validators/field_manual_vault'

export default class FieldManualVaultController {
  private get service() {
    return new FieldManualVaultService()
  }

  async index({ inertia }: HttpContext) {
    const status = await this.service.getStatus()
    return inertia.render('field-manuals/index', { status })
  }

  async status() {
    return this.service.getStatus()
  }

  async download({ request, response }: HttpContext) {
    const { edition } = await request.validateUsing(fieldManualEditionValidator)
    try {
      const result = await this.service.start(edition)
      if (!result.success) return response.status(result.status).send(result)
      return result
    } catch (error) {
      logger.error(`[FieldManualVault] download failed: ${messageOf(error)}`)
      return response.internalServerError({ success: false, message: 'Could not start the download' })
    }
  }

  async cancel({ request, response }: HttpContext) {
    const { edition } = await request.validateUsing(fieldManualEditionValidator)
    try {
      return await this.service.cancel(edition)
    } catch (error) {
      logger.error(`[FieldManualVault] cancel failed: ${messageOf(error)}`)
      return response.internalServerError({ success: false, message: 'Could not cancel the download' })
    }
  }

  async remove({ request, response }: HttpContext) {
    const { edition } = await request.validateUsing(fieldManualEditionValidator)
    try {
      const result = await this.service.remove(edition)
      if (!result.success) return response.status(result.status).send(result)
      return result
    } catch (error) {
      logger.error(`[FieldManualVault] remove failed: ${messageOf(error)}`)
      return response.internalServerError({ success: false, message: 'Could not remove the download' })
    }
  }

  async search({ request }: HttpContext) {
    const query = await request.validateUsing(fieldManualSearchValidator)
    return this.service.search({
      q: query.q,
      family: query.family,
      branch: query.branch,
      pubType: query.pub_type,
      offset: query.offset,
      limit: query.limit,
    })
  }

  async open({ request, response }: HttpContext) {
    const payload = await request.validateUsing(fieldManualOpenValidator)
    try {
      const opened = await this.service.open(payload.params.id, payload.format)
      if (!('stream' in opened)) {
        return response.status(opened.status).send({ message: opened.message })
      }
      response.header('Content-Type', opened.contentType)
      response.header('Content-Length', String(opened.size))
      response.header('Content-Disposition', opened.disposition)
      response.header('X-Content-Type-Options', 'nosniff')
      response.header('Cache-Control', 'private')
      return response.stream(opened.stream)
    } catch (error) {
      logger.error(`[FieldManualVault] open failed: ${messageOf(error)}`)
      return response.internalServerError({ message: 'Could not open that manual' })
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
