import http from 'k6/http'
import { check, sleep } from 'k6'

export const options = { vus: 1, duration: '2s', thresholds: { checks: ['rate==1'] } }

export default function () {
  const response = http.get(__ENV.BASE_URL + '/api')
  check(response, { 'expected response': r => r.status === 200 && r.json('ok') === true })
  sleep(0.2)
}
