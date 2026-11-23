import { readFile } from 'node:fs/promises'
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import { TorrentDownloadService } from '#services/torrent_download_service'
import { torrentIdValidator, torrentSourceValidator } from '#validators/torrent_download'

const TORRENT_FILE_LIMIT = 5 * 1024 * 1024

export default class TorrentDownloadController {
  private get service() {
    return new TorrentDownloadService()
  }

  async index({ inertia }: HttpContext) {
    const status = await this.service.getStatus()
    return inertia.render('torrents/index', { status })
  }

  async status() {
    return this.service.getStatus()
  }

  async add({ request, response }: HttpContext) {
    const { source } = await request.validateUsing(torrentSourceValidator)
    return this.respond(response, () => this.service.addFromSource(source), 'Could not start the download')
  }

  async upload({ request, response }: HttpContext) {
    const uploaded = request.file('torrent', { size: '5mb', extnames: ['torrent'] })
    if (!uploaded || !uploaded.isValid || !uploaded.tmpPath) {
      return response.badRequest({ success: false, message: 'Choose a .torrent file.' })
    }
    if (uploaded.size > TORRENT_FILE_LIMIT) {
      return response.badRequest({ success: false, message: 'Choose a torrent file under 5 MB.' })
    }
    const bytes = await readFile(uploaded.tmpPath)
    return this.respond(response, () => this.service.addFromFile(bytes), 'Could not start the download')
  }

  async pause({ request, response }: HttpContext) {
    const { params } = await request.validateUsing(torrentIdValidator)
    return this.respond(response, () => this.service.pause(params.id), 'Could not pause the download')
  }

  async resume({ request, response }: HttpContext) {
    const { params } = await request.validateUsing(torrentIdValidator)
    return this.respond(response, () => this.service.resume(params.id), 'Could not resume the download')
  }

  async remove({ request, response }: HttpContext) {
    const { params } = await request.validateUsing(torrentIdValidator)
    return this.respond(response, () => this.service.remove(params.id), 'Could not remove the download')
  }

  private async respond(
    response: HttpContext['response'],
    action: () => Promise<{ success: boolean; status: number; message: string }>,
    fallback: string
  ) {
    try {
      const result = await action()
      if (!result.success) return response.status(result.status).send(result)
      return result
    } catch (error) {
      logger.error(`[Torrents] ${fallback}: ${error instanceof Error ? error.message : String(error)}`)
      return response.internalServerError({ success: false, message: fallback })
    }
  }
}
