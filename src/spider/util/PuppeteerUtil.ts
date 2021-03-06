import {DownloadUtil} from "../../common/util/DownloadUtil";
import * as os from "os";
import {Page, Request, Response} from "puppeteer";
import {FileUtil} from "../../common/util/FileUtil";
import * as fs from "fs";
import {Defaults} from "../data/Defaults";
import {LinkPredictMap} from "../data/Types";
import {logger} from "../../common/util/logger";
import {PromiseUtil} from "../../common/util/PromiseUtil";

export type ResponseListener = (response: Response) => any;

export enum DownloadImgError {
    Timeout = "Timeout",
    ImgNotFound = "ImgNotFound",
    DownloadFail = "DownloadFail",
    MkdirsFail = "MkdirsFail",
    WriteFileFail = "WriteFileFail",
}

export type FireInfo = {
    max: number;
    cur: number;
}

export type DownloadImgResult = {
    success: boolean;
    cost: number;
    src?: string;
    size?: number;
    savePath?: string;
    error?: DownloadImgError;
    status?: number;
};

export type ResponseCheckUrlResult = {
    url: string | RegExp,
    fireInfo: FireInfo;
    timeout: number;
    isTimeout: boolean;
    error?: Error;
}

type ResponseCheckUrlInfo = {
    url: string | RegExp,
    listener: ResponseListener;
    resolve: (checkResult: ResponseCheckUrlResult) => any;
    fireInfo: FireInfo;
    timeout: number;
}

const kRequestInterceptionNum = "_requestInterceptionNum";
const kRequestInterception_ImgLoad = "_requestListener_imgLoad";

const kResponseCheckUrls = "_responseCheckUrls";
const kResponseListener = "_responseListener";

const onePxBuffer = [82, 73, 70, 70, 74, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88, 10, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 65, 76, 80, 72, 12, 0, 0, 0, 1, 7, 16, 17, 253, 15, 68, 68, 255, 3, 0, 0, 86, 80, 56, 32, 24, 0, 0, 0, 48, 1, 0, 157, 1, 42, 1, 0, 1, 0, 3, 0, 52, 37, 164, 0, 3, 112, 0, 254, 251, 253, 80, 0];

export class PuppeteerUtil {

    /**
     * 设置Page默认的分辨率，1920 * 1080
     * @param {Page} page
     * @returns {Promise<void>}
     */
    static async defaultViewPort(page: Page) {
        await page.setViewport({
            width: 1920,
            height: 1080
        });
    }

    /**
     * 向 Page 中注入 jQuery，一定要在 await page.goto(url) 之后调用
     * @param {Page} page
     * @param {string} url
     * @param {string} savePath
     * @returns {Promise<void>}
     */
    static async addJquery(
        page: Page,
        url: string = "https://cdn.bootcss.com/jquery/3.3.1/jquery.min.js",
        savePath = os.tmpdir() + "/jquery.min.js") {
        const jQueryExisted = await page.evaluate(() => {
           return typeof jQuery !== "undefined";
        });

        if (!jQueryExisted) {
            await DownloadUtil.download(url, savePath).then(async res => {
                if (res > 0) {
                    // 某些网站（例如twitter）因为安全问题会导致js注入失败，所以弃用这种方式
                    // await page.addScriptTag({
                    //     path: savePath
                    // });
                    const jQueryStr = fs.readFileSync(savePath, "utf-8");
                    await page.evaluate(jQueryStr => {
                        eval(jQueryStr);
                    }, jQueryStr);
                }
            });
        }
    }

    /**
     * 解析jsonp字符串中的json数据
     * @param {string} jsonp
     * @returns {any}
     */
    // noinspection JSUnusedGlobalSymbols
    static jsonp(jsonp: string): any {
        let index;
        if (jsonp == null || (index = jsonp.indexOf('(')) == -1) return {};
        try {
            const callbackName = jsonp.substring(0, index);
            const evalStr = `function ${callbackName}(arg) { return arg; }\n${jsonp}`;
            return eval(evalStr);
        }
        catch (e) {
            logger.warn(e.stack);
            return {};
        }
    }

    private static async requestInterceptionNumDelta(page: Page, delta: number) {
        let requestInterceptionNum = (page[kRequestInterceptionNum] || 0) + delta;
        if (requestInterceptionNum < 0) requestInterceptionNum = 0;
        page[kRequestInterceptionNum] = requestInterceptionNum;
        await page.setRequestInterception(requestInterceptionNum > 0);
    }

    /**
     * 是指是否阻止图片加载
     * @param {Page} page
     * @param {boolean} enable
     * @returns {Promise<void>}
     */
    static async setImgLoad(page: Page, enable: boolean) {
        await this.requestInterceptionNumDelta(page, enable ? -1 : 1);
        if (enable) {
            if (page[kRequestInterception_ImgLoad]) {
                page.removeListener("request", page[kRequestInterception_ImgLoad]);
            }
        }
        else {
            if (!page[kRequestInterception_ImgLoad]) {
                page[kRequestInterception_ImgLoad] = async (request: Request) => {
                    const interceptionHandled = request["_interceptionHandled"];
                    if (!interceptionHandled) {
                        if (request.resourceType() == "image") {
                            const requestUrl = request.url();
                            let responseCheckUrls: ResponseCheckUrlInfo[] = page[kResponseCheckUrls] || [];
                            if (responseCheckUrls.find(item => {
                                let checkUrl = item.url.toString();
                                if (checkUrl.startsWith("//")) checkUrl = requestUrl.split("//")[0] + checkUrl;
                                return requestUrl.match(checkUrl) != null || checkUrl === requestUrl;
                            })) {
                                // 下载图片，不阻止
                                request.continue();
                            }
                            else {
                                // 屏蔽原本的请求行为，直接返回 格式为webp 大小为 1px 的默认图片
                                await request.respond({
                                    status: 200,
                                    contentType: "image/webp",
                                    body: Buffer.from(onePxBuffer)
                                });
                            }
                        }
                        else request.continue(); // 非图片请求，直接放行
                    }
                };
            }
            page.on("request", page[kRequestInterception_ImgLoad]);
        }
    }

    private static initResponseListener(page: Page) {
        let responseListener: ResponseListener = page[kResponseListener];
        if (!responseListener) {
            page[kResponseListener] = responseListener = async (response: Response) => {
                const responseUrl = response.url();
                let responseCheckUrls: ResponseCheckUrlInfo[] = page[kResponseCheckUrls] || [];
                const removes = [];
                for (let responseCheckUrl of responseCheckUrls) {
                    let checkUrl = responseCheckUrl.url.toString();
                    if (checkUrl.startsWith("//")) checkUrl = responseUrl.split("//")[0] + checkUrl;
                    if (responseUrl === checkUrl || responseUrl.match(checkUrl)) {
                        try {
                            await responseCheckUrl.listener(response);
                        }
                        catch (e) {
                            console.warn(e);
                        }

                        responseCheckUrl.fireInfo.cur++;
                        if (responseCheckUrl.fireInfo.max > 0 && responseCheckUrl.fireInfo.cur >= responseCheckUrl.fireInfo.max) {
                            removes.push(responseCheckUrl);
                            responseCheckUrl.resolve({
                                url: responseCheckUrl.url,
                                fireInfo: responseCheckUrl.fireInfo,
                                timeout: responseCheckUrl.timeout,
                                isTimeout: false
                            });
                        }
                    }
                }
                for (let remove of removes) {
                    responseCheckUrls.splice(responseCheckUrls.indexOf(remove), 1);
                }
            };
            page.on("response", responseListener);
        }
    }

    private static addResponseCheckUrlInfo(page: Page, responseCheckUrlInfo: ResponseCheckUrlInfo) {
        if (page == null || responseCheckUrlInfo == null) return;

        let responseCheckUrls: ResponseCheckUrlInfo[] = page[kResponseCheckUrls];
        if (!responseCheckUrls) {
            page[kResponseCheckUrls] = responseCheckUrls = [];
        }
        responseCheckUrls.push(responseCheckUrlInfo);
        this.initResponseListener(page);
    }

    /**
     * 监听返回结果
     * @param {Page} page
     * @param {string | RegExp} url
     * @param {ResponseListener} listener
     * @param {number} fireMax
     * @param {number} timeout
     * @returns {Promise<ResponseCheckUrlResult>}
     */
    static onResponse(page: Page, url: string | RegExp, listener: ResponseListener, fireMax: number = -1, timeout: number = Defaults.responseTimeout): Promise<ResponseCheckUrlResult> {
        fireMax = parseInt("" + fireMax);
        return new Promise<ResponseCheckUrlResult>(resolve => {
            const fireInfo: FireInfo = {
                max: fireMax,
                cur: 0
            };
            const responseCheckUrl: ResponseCheckUrlInfo = {
                url: url,
                listener: listener,
                resolve: resolve,
                fireInfo: fireInfo,
                timeout: timeout
            };
            const responseCheckUrlRes: ResponseCheckUrlResult = {
                url: url,
                fireInfo: fireInfo,
                timeout: timeout,
                isTimeout: false
            };

            try {
                this.addResponseCheckUrlInfo(page, responseCheckUrl);

                if (fireMax > 0) {
                    setTimeout(() => {
                        responseCheckUrlRes.isTimeout = true;
                        resolve(responseCheckUrlRes);
                    }, timeout < Defaults.responseTimeoutMin ? Defaults.responseTimeoutMin : timeout);
                }
                else {
                    resolve(responseCheckUrlRes);
                }
            }
            catch (e) {
                this.removeResponseListener(page, url);
                responseCheckUrlRes.error = e;
                resolve(responseCheckUrlRes);
            }
        });
    }

    /**
     * 监听返回结果，监听成功一次后结束
     * @param {Page} page
     * @param {string | RegExp} url
     * @param {ResponseListener} listener
     * @param {number} timeout
     * @returns {Promise<ResponseCheckUrlResult>}
     */
    static onceResponse(page: Page, url: string | RegExp, listener: ResponseListener, timeout?: number): Promise<ResponseCheckUrlResult> {
        return this.onResponse(page, url, listener, 1, timeout);
    }

    private static removeResponseListener(page: Page, url: string | RegExp) {
        if (page == null || url == null) return;

        let responseCheckUrls = page[kResponseCheckUrls];
        if (responseCheckUrls) {
           while (true) {
               const index = responseCheckUrls.findIndex(item => item.url === url);
               if (index > -1) {
                    responseCheckUrls.splice(index, 1);
               }
               else break;
           }
        }
    }

    /**
     * 下载图片
     * @param {Page} page
     * @param {string} selectorOrSrc 图片的地址或者 img节点的css selector
     * @param {string} saveDir 图片保存目录
     * @param {number} timeout 超时时间
     * @returns {Promise<DownloadImgResult>}
     */
    static downloadImg(page: Page, selectorOrSrc: string, saveDir: string, timeout: number = Defaults.responseTimeout): Promise<DownloadImgResult> {
        const time = new Date().getTime();
        return new Promise<DownloadImgResult>(async resolve => {
            const imgId = "img_" + time + parseInt("" + Math.random() * 10000);
            const imgSrc = await page.evaluate((selectorOrSrc, imgId) => {
                try {
                    const isSrc = selectorOrSrc.startsWith("http") || selectorOrSrc.startsWith("//");
                    if (isSrc) {
                        const img = document.createElement("img");
                        img.id = imgId;
                        img.style.display = "none";
                        document.body.appendChild(img);
                        window[imgId] = img;
                        return selectorOrSrc;
                    }
                    else {
                        const img = document.querySelector(selectorOrSrc) as any;
                        if (img) {
                            window[imgId] = img;
                            return img.src;
                        }
                    }
                }
                catch (e) {
                    console.warn(e.stack);
                }
                return false;
            }, selectorOrSrc, imgId);

            if (imgSrc) {
                const newImgSrc = imgSrc + (imgSrc.indexOf("?") == -1 ? "?" : "&") + new Date().getTime() + "_" + (Math.random() * 10000).toFixed(0);
                const waitRespnse = this.onceResponse(page, newImgSrc, async (response: Response) => {
                    if (response.ok()) {
                        let saveName = null;
                        let suffix = "png";

                        const contentType = (await response.headers())["content-type"];
                        if (contentType && contentType.match("^image/.*")) {
                            suffix = contentType.substring(6);
                        }

                        let match;
                        if (match = imgSrc.match(".*/([^.?&/]+).*$")) {
                            saveName = match[1] + "." + suffix;
                        }

                        if (!saveName) saveName = new Date().getTime() + "_" + parseInt("" + Math.random() * 1000) + "." + suffix;
                        if (FileUtil.mkdirs(saveDir)) {
                            const savePath = (saveDir + (saveDir.endsWith("/") ? "" : "/") + saveName).replace(/\\/g, '/');
                            const buffer = await response.buffer();
                            fs.writeFile(savePath, buffer, err => {
                                if (err) {
                                    resolve({
                                        success: false,
                                        cost: new Date().getTime() - time,
                                        error: DownloadImgError.WriteFileFail
                                    });
                                }
                                else {
                                    resolve({
                                        success: true,
                                        cost: new Date().getTime() - time,
                                        src: imgSrc,
                                        size: buffer.length,
                                        savePath: savePath
                                    });
                                }
                            });
                        }
                        else {
                            resolve({
                                success: false,
                                cost: new Date().getTime() - time,
                                error: DownloadImgError.MkdirsFail
                            });
                        }
                    }
                    else {
                        resolve({
                            success: false,
                            cost: new Date().getTime() - time,
                            error: DownloadImgError.DownloadFail,
                            status: response.status()
                        });
                    }
                }, timeout);
                await page.evaluate((imgId, newSrc) => {
                    window[imgId].src = newSrc;
                }, imgId, newImgSrc);
                await waitRespnse.then(res => {
                    if (res.isTimeout) {
                        resolve({
                            success: false,
                            cost: new Date().getTime() - time,
                            error: DownloadImgError.Timeout
                        });
                    }
                });
            }
            else {
                resolve({
                    success: false,
                    cost: new Date().getTime() - time,
                    error: DownloadImgError.ImgNotFound
                });
            }
        });
    }

    /**
     * 获取符合要求的url
     * @param {Page} page
     * @param {LinkPredictMap} predicts
     * @param {boolean} onlyAddToFirstMatch 是否只添加到第一个匹配的列表中
     * @returns {Promise<any>}
     */
    static async links(page: Page, predicts: LinkPredictMap, onlyAddToFirstMatch: boolean = true) {
        if (predicts == null || Object.keys(predicts).length == 0) return {};

        const predictStrMap: any = {};
        for (let groupName of Object.keys(predicts)) {
            const predict = predicts[groupName];
            if (predict.constructor == Array) {
                predictStrMap[groupName] = [
                    predict[0],
                    (typeof predict[1] === "function" ? "function" : "string") + " " + (predict[1] || "").toString()
                ];
            }
            else predictStrMap[groupName] = (typeof predict === "function" ? "function" : "string") + " " + predict.toString();
        }
        return await page.evaluate((predictStrMap, onlyAddToFirstMatch) => {
            const hrefs = {};
            const existed = {};
            const all = document.querySelectorAll("a") || [];
            for (let groupName of Object.keys(predictStrMap)) {
                const predict = predictStrMap[groupName];
                let selector = null;
                let predictStr = null;
                let predictRegOrFun = null;
                if (predict.constructor == Array) {
                    selector = predict[0];
                    predictStr = predict[1];
                }
                else predictStr = predict;

                const spaceI = predictStr.indexOf(' ');
                const predictType = predictStr.substring(0, spaceI);
                const predictRegPrFunStr = predictStr.substring(spaceI + 1);
                if (predictType == "function") {
                    eval("predictRegOrFun = " + predictRegPrFunStr);
                }
                else predictRegOrFun = predictRegPrFunStr;

                const aArr = selector ? (document.querySelectorAll(selector) || []) : all;
                const matchHrefs = {};
                for (let a of aArr) {
                    let href = (a as any).href;
                    if (!onlyAddToFirstMatch || !existed[href]) {
                        let match = false;
                        if (typeof predictRegOrFun == 'function') {
                            if (href = predictRegOrFun(a)) {
                                match = true;
                            }
                        }
                        else {
                            if (href.match(predictRegOrFun)) match = true;
                        }
                        if (match) {
                            matchHrefs[href] = true;
                            if (onlyAddToFirstMatch) {
                                existed[href] = true;
                            }
                        }
                    }
                }
                hrefs[groupName] = Object.keys(matchHrefs);
            }
            return hrefs;
        }, predictStrMap, onlyAddToFirstMatch);
    }

    /**
     * 获取 满足 css selector 的节点个数
     * @param {Page} page
     * @param {string} selector
     * @returns {Promise<number>}
     */
    static count(page: Page, selector: string): Promise<number> {
        return page.evaluate(selector => {
            const doms = document.querySelectorAll(selector);
            if (doms) return doms.length;
            else return 0;
        }, selector);
    }

    /**
     * 通过 jQuery 找到符合 css selector 的所有节点，并给其中没有id属性的节点设置特殊的id，并返回所有节点的id
     * @param {Page} page
     * @param {string} selector
     * @returns {Promise<string[]>}
     */
    static async specifyIdByJquery(page: Page, selector: string): Promise<string[]> {
        await this.addJquery(page);
        return await page.evaluate(selector => {
           const $items = jQuery(selector);
           if ($items.length) {
               const ids = [];
               for (let i = 0; i < $items.length; i++) {
                   const $item = $($items[i]);
                   const id = $item.attr("id");
                   if (id) {
                       ids.push(id);
                   }
                   else {
                       const specialId = "special_" + new Date().getTime() + "_" + (Math.random() * 99999).toFixed(0) + "_" + i;
                       $item.attr("id", specialId);
                       ids.push(specialId);
                   }
               }
               return ids;
           }
           else return null;
        }, selector);
    }

    /**
     * 滚动到最底部，特殊的滚动需求可以参考这个自行编写
     * @param {Page} page
     * @param {number} scrollTimeout
     * @param {number} scrollInterval
     * @param {number} scrollYDelta
     * @returns {Promise<boolean>}
     */
    static scrollToBottom(page: Page, scrollTimeout: number = 30000, scrollInterval: number = 250, scrollYDelta: number = 500) {
        return new Promise<boolean>( resolve => {
            if (scrollTimeout > 0) {
                setTimeout(() => {
                    resolve(false);
                }, scrollTimeout);
            }

            let lastScrollY;
            let scrollYEqualNum = 0;
            const scrollAndCheck = () => {
                page.evaluate((scrollYDelta) => {
                    window.scrollBy(0, scrollYDelta);
                    return window.scrollY;
                }, scrollYDelta).then(scrollY => {
                    if (lastScrollY == scrollY) {
                        scrollYEqualNum++;
                        if (scrollYEqualNum >= 4) {
                            resolve(true);
                        }
                        else setTimeout(scrollAndCheck, 250);
                    }
                    else {
                        scrollYEqualNum = 0;
                        lastScrollY = scrollY;
                        setTimeout(scrollAndCheck, scrollInterval);
                    }
                });
            };
            scrollAndCheck();
        });
    }

}