'use strict'

const path = require('path')
const chalk = require('chalk')
const parse5 = require('parse5')
const _ = require('lodash')
const fs = require('fs')
const SVGO = require('svgo')
const svgoDefaultConfig = require(path.resolve(__dirname, 'svgo-config.js'))

const selfProps = ['inline', 'src'];

const getImageAttribute = (inlineImage, attributeName) => {
  const svgSrcObject = _.find(inlineImage.attrs, {name: attributeName})

  // image does not have a src attribute

  if (!svgSrcObject) return ''

  // grab the image src

  return svgSrcObject.value
}

const spreadAttributes = ({attrs: attributes}, svgString) => {
  const copyAttrs = [];
  attributes.forEach(({name, value}) => {
    if (!selfProps.includes(name)) {
      if (value) {
        copyAttrs.push(`${name}="${value}"`)
      } else {
        copyAttrs.push(name);
      }
    }
  });
  return copyAttrs.length
    ? svgString.replace('<svg ', '<svg ' + copyAttrs.join(' ') + ' ')
    : svgString
}

/**
 * class to inline SVGs within html-webpack-plugin templates
 *
 */
class HtmlWebpackInlineSVGPlugin {

  constructor(options) {
    this.userConfig = ''
    this.outputPath = (options ? options.path : '') || ''

    this.files = []
  }


  /**
   * required to create a webpack plugin
   * @param {object} compiler - webpack compiler
   *
   */
  apply(compiler) {
    // Hook into the html-webpack-plugin processing

    compiler.plugin('compilation', (compilation) => {

      compilation.plugin('html-webpack-plugin-before-html-processing', (htmlPluginData, callback) => {

        // fetch the output path from webpack

        this.assets = compilation.assets;

        this.outputPath =
          this.outputPath ||
          compilation.outputOptions &&
          compilation.outputOptions.path ||
          '';

        if (!this.outputPath) {

          console.log(chalk.red('no output path found on compilation.outputOptions'))

          callback(null, htmlPluginData)

          return

        }


        // get the custom config

        this.userConfig =
          htmlPluginData.plugin.options.svgoConfig &&
          _.isObject(htmlPluginData.plugin.options.svgoConfig) ?
            htmlPluginData.plugin.options.svgoConfig :
            {};

        // get the filename

        const filename = htmlPluginData.outputName ? htmlPluginData.outputName : ''

        if (!filename) {
          console.log(chalk.red('no filename found on htmlPluginData.outputName'))
          callback(null, htmlPluginData)
          return
        }

        // get the emitted HTML - prior to SVG's being inlined

        const originalHtml = htmlPluginData.html;//.source()
        const template = htmlPluginData.plugin.options.template.split('!').reverse()[0];

        this.processImages(template, originalHtml)
          .then(html => {
            callback(null, {...htmlPluginData, html})
          })
          .catch(err => callback(err, null));
      })

    });
  }

  /**
   * find all inline images and replace their html within the output
   * @param {string} html - generated html from html-webpack-plugin
   * @returns {Promise}
   *
   */
  processImages(fileName, html) {

    return new Promise((resolve, reject) => {

      const documentFragment = parse5.parseFragment(html, {
        locationInfo: true
      })

      // grab the images to process from the original DOM fragment

      const inlineImages = this.getInlineImages(documentFragment)

      // if we have no inlined images return the html

      if (!inlineImages.length) return resolve(html)

      // process the imageNodes

      this.updateHTML(fileName, html, inlineImages)
        .then((html) => resolve(html))
        .catch((err) => {
          console.log(chalk.underline.red('processImages hit error'))
          console.log(chalk.red(err))

          reject(err)
        })

    })

  }


  /**
   * run the Promises in a synchronous order
   * allows us to ensure we have completed processing of an inline image
   * before the next ones Promise is called (via then chaining)
   * @param {object} html
   * @param {array} inlineImages
   * @returns {Promise}
   *
   */
  updateHTML(fileName, html, inlineImages) {
    return inlineImages.reduce((promise, imageNode) => {
      return promise.then((html) => {
        return this.processImage(fileName, html)
      })
    }, Promise.resolve(html))
  }


  /**
   * get the first inline image and replace it with its inline SVG
   * @returns {Promise}
   *
   */
  processImage(fileName, html) {

    return new Promise((resolve, reject) => {
      // rebuild the document fragment each time with the updated html
      const documentFragment = parse5.parseFragment(html, {
        locationInfo: true,
      })

      const inlineImage = this.getFirstInlineImage(documentFragment)

      if (inlineImage) {
        this.processOutputHtml(fileName, html, inlineImage)
          .then((html) => resolve(html))
          .catch((err) => reject(err))

      } else {
        // no inline image - just resolve

        resolve(html)
      }
    })
  }


  /**
   * get a count for how many inline images the html document contains
   * @param {Object} documentFragment - parse5 processed html
   * @param {array} inlineImages
   * @returns {array}
   *
   */
  getInlineImages(documentFragment, inlineImages) {
    if (!inlineImages) inlineImages = []
    if (documentFragment.childNodes && documentFragment.childNodes.length) {
      documentFragment.childNodes.forEach((childNode) => {
        if (this.isNodeValidInlineImage(childNode)) {
          inlineImages.push(childNode)
        } else {
          inlineImages = this.getInlineImages(childNode, inlineImages)
        }
      })
    }

    return inlineImages
  }


  /**
   * return the first inline image or false if none
   * @param {Object} documentFragment - parse5 processed html
   * @returns {null|Object} - null if no inline image - parse5 documentFragment if there is
   *
   */
  getFirstInlineImage(documentFragment) {
    const inlineImages = this.getInlineImages(documentFragment)
    if (!inlineImages.length) return null
    return inlineImages[0]
  }


  /**
   * check if a node is a valid inline image
   * @param {Object} node - parse5 documentFragment
   * @returns {boolean}
   *
   */
  isNodeValidInlineImage(node) {
    return !!(
      node.nodeName === 'img' &&
      _.filter(node.attrs, {name: 'inline'}).length &&
      this.getImagesSrc(node))
  }

  /**
   * get an inlined images src
   * @param {Object} inlineImage - parse5 document
   * @returns {string}
   *
   */
  getImagesSrc(inlineImage) {
    // grab the image src

    const svgSrc = getImageAttribute(inlineImage, 'src')

    // image src attribute must not be blank and it must be referencing a file with a .svg extension

    return svgSrc && svgSrc.indexOf('.svg') !== -1 ? svgSrc : ''

  }


  /**
   * append the inlineImages SVG data to the output HTML and remove the original img
   * @param {string} html
   * @param {Object} inlineImage - parse5 document
   * @returns {Promise}
   *
   */
  processOutputHtml(fileName, html, inlineImage) {

    return new Promise((resolve, reject) => {
      const svgSrc = this.getImagesSrc(inlineImage)

      // if the image isn't valid resolve

      if (!svgSrc) return resolve(html)

      const asset = this.assets[svgSrc];
      if (asset) {
        const data = asset.source().toString('utf8');
        const configObj = Object.assign(svgoDefaultConfig, this.userConfig)
        const config = {}

        // pass all objects to the config.plugins array

        config.plugins = _.map(configObj, (value, key) => ({[key]: value}));

        // create a new instance of SVGO
        // passing it the merged config, to optimize the svg

        const svgo = new SVGO(config)

        svgo.optimize(data)
          .then((result) => {
            const optimisedSVG = result.data
            html = this.replaceImageWithSVG(
              html,
              inlineImage,
              spreadAttributes(inlineImage, optimisedSVG)
            )

            resolve(html)
          })
          .catch((err) => console.log(chalk.red(err.message)))
      } else {
        reject('no such asset ' + svgSrc);
      }
    })
  }


  /**
   * replace the img with the optimised SVG
   * @param {string} html
   * @param {Object} inlineImage - parse5 document
   * @param {Object} svg
   *
   */
  replaceImageWithSVG(html, inlineImage, svg) {

    const start = inlineImage.__location.startOffset
    const end = inlineImage.__location.endOffset

    // remove the img tag and add the svg content

    return html.substring(0, start) + svg + html.substring(end)
  }
}

module.exports = HtmlWebpackInlineSVGPlugin
