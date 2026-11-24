package com.commontools.CommonFabricWeaver

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.IOException

internal class IOSPeopleSummaryFailure(val retryMillis: Long) : IOException("People summary is not available")

/** Visible-row summary adapter. PersonKey, endpoint, query escaping, summary
 * typing and email/phone preference are all the actual Apple implementation.
 * Non-2xx statuses use the shared bounded holdoff and never mean an empty
 * person. This older summary adapter does not yet consume LoomHTTP's full
 * gate or Retry-After; the canonical list walk does. The existing on-open PersonCard remains available;
 * this does not bypass Apple's queued/launch-quiet page fallback with row GETs. */
class IOSPeopleSummaryRepository(private val transport: IOSPeopleTransport = IOSPeopleHTTPTransport()) {
    private val permits = Semaphore(2)

    suspend fun read(person: IOSPersonTarget, baseURL: String): IOSPeopleSummary = permits.withPermit {
        val origin = iosPeopleOrigin(baseURL)
        val request = withContext(Dispatchers.Default) { IOSPeopleCore.summaryRequest(person.rel, origin,
            person.id.takeIf { person.servedIdentity }) }
        val response = try { transport.get(request.url, request.timeoutMillis, 2 * 1024 * 1024) }
        catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { throw IOSPeopleSummaryFailure(IOSPeopleCore.summaryPolicy.transientMillis) }
        if (response.status != 200) throw IOSPeopleSummaryFailure(withContext(Dispatchers.Default) {
            IOSPeopleCore.summaryHTTPFailureMillis(response.status)
        })
        try { withContext(Dispatchers.Default) { IOSPeopleCore.summaryRead(response.body.toString(Charsets.UTF_8)) } }
        catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { throw IOSPeopleSummaryFailure(IOSPeopleCore.summaryPolicy.permanentMillis) }
    }
}
