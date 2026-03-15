import React, { useState } from 'react';
import { FileText, CheckCircle, ChevronRight, RefreshCw } from 'lucide-react';
import { uploadQuestionnaire } from '../services/cosService';
import { useApp } from '../context/AppContext';
import { isGuestMode } from '../data/testData';

const SurveySection = ({ onStartSurvey, isCompleted }) => {
  const [showSurvey, setShowSurvey] = useState(false);
  const { user, setUserProfile } = useApp();

  const handleStartSurvey = () => {
    setShowSurvey(true);
  };

  const handleCloseSurvey = async () => {
    setShowSurvey(false);
    onStartSurvey();
    
    // 游客模式下不保存到COS
    if (isGuestMode(user?.userId)) {
      console.log('游客模式：问卷数据不保存到COS');
      return;
    }
    
    // 上传问卷完成状态到COS
    const questionnaireData = {
      userId: user?.userId || 'current_user', // 使用实际的用户ID
      completedAt: new Date().toISOString(),
      status: 'completed',
      answers: {} // 这里应该包含实际的问卷答案
    };
    
    const uploadResult = await uploadQuestionnaire(questionnaireData);
    if (uploadResult.success) {
      console.log('问卷数据已保存到COS:', uploadResult.cosUrl);
    } else {
      console.error('问卷数据保存失败:', uploadResult.error);
    }
  };

  return (
    <div className="bg-white rounded-2xl p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-800 mb-4">情绪健康问卷</h2>
      
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-4 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg">
          <div className="w-10 h-10 bg-gradient-to-r from-blue-500 to-purple-500 rounded-full flex items-center justify-center flex-shrink-0">
            <FileText className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <h3 className="font-medium text-gray-800 mb-1">大学生情绪健康调研</h3>
            <p className="text-sm text-gray-600 mb-3">
              通过科学的问卷评估，帮助你更好地了解自己的情绪状态，获得个性化的心理健康建议。
            </p>
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span>预计用时：5-8分钟</span>
              <span>•</span>
              <span>匿名填写</span>
              <span>•</span>
              <span>专业评估</span>
            </div>
          </div>
        </div>

        {isCompleted ? (
          <div className="flex items-center gap-3 p-4 bg-green-50 rounded-lg">
            <CheckCircle className="w-6 h-6 text-green-600" />
            <div>
              <p className="font-medium text-green-800">问卷已完成</p>
              <p className="text-sm text-green-600">感谢你的参与，你的回答对我们的研究很重要</p>
            </div>
            <button
              onClick={handleStartSurvey}
              className="ml-auto px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium hover:bg-green-200 transition-colors duration-200 flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" />
              重新填写
            </button>
          </div>
        ) : (
          <button
            onClick={handleStartSurvey}
            className="w-full bg-gradient-to-r from-blue-500 to-purple-500 text-white py-3 rounded-lg font-medium hover:shadow-lg transition-all duration-200 flex items-center justify-center gap-2"
          >
            开始填写问卷
            <ChevronRight className="w-5 h-5" />
          </button>
        )}

        <div className="text-xs text-gray-500 text-center">
          <p>本问卷由厦门大学心理健康教育与咨询中心支持</p>
          <p>数据仅用于学术研究，严格保密</p>
        </div>
      </div>

      {/* 本地问卷弹窗 */}
      {showSurvey && (
        <LocalSurveyModal onClose={handleCloseSurvey} />
      )}
    </div>
  );
};

// 本地问卷弹窗组件
const LocalSurveyModal = ({ onClose }) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState({});

  const questions = [
    {
      id: 'stress',
      title: '你最近的主要压力来源是？',
      options: ['学业压力', '人际关系', '未来规划', '经济压力', '家庭期望', '实习压力', '工作压力']
    },
    {
      id: 'coping',
      title: '你通常如何缓解压力？',
      options: ['运动锻炼', '听音乐', '和朋友聊天', '独自思考', '吃东西']
    },
    {
      id: 'sleep',
      title: '你的睡眠质量如何？',
      options: ['很好，7-8小时', '一般，6-7小时', '较差，经常失眠', '不规律']
    },
    {
      id: 'relax',
      title: '你最喜欢的放松方式是？',
      options: ['散步', '看电影', '玩游戏', '读书', '冥想']
    },
    {
      id: 'future',
      title: '你对未来有什么期待？',
      options: ['顺利毕业', '找到好工作', '继续深造', '创业', '环游世界']
    }
  ];

  const handleAnswer = (questionId, answer) => {
    setAnswers(prev => ({
      ...prev,
      [questionId]: answer
    }));
  };

  const handleNext = async () => {
    if (currentStep < questions.length - 1) {
      setCurrentStep(currentStep + 1);
      return;
    }

    // 保存问卷结果到本地存储（使用用户特定的key）
    localStorage.setItem('surveyCompleted', 'true');
    localStorage.setItem(`surveyAnswers_${user?.userId || 'current_user'}`, JSON.stringify(answers));

    // 更新用户资料中的问卷完成状态
    setUserProfile(prev => ({
      ...prev,
      surveyCompleted: true,
      moodProfile: answers
    }));

    // 先关闭弹窗，避免等待网络请求导致用户感知卡顿
    onClose();

    // 异步上传问卷数据到COS（游客模式不上传）
    if (!isGuestMode(user?.userId)) {
      (async () => {
        try {
          const questionnaireData = {
            userId: user?.userId || 'current_user',
            completedAt: new Date().toISOString(),
            status: 'completed',
            answers: answers
          };

          const uploadResult = await uploadQuestionnaire(questionnaireData);
          if (uploadResult.success) {
            console.log('问卷数据已保存到COS:', uploadResult.cosUrl);
          } else {
            console.error('问卷数据保存失败:', uploadResult.error);
          }
        } catch (error) {
          console.error('问卷上传出错:', error);
        }
      })();
    }

    // 重置问卷步数和答案，确保下次打开时从头开始
    setCurrentStep(0);
    setAnswers({});
  };

  const currentQuestion = questions[currentStep];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-gray-800">情绪健康问卷</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            ×
          </button>
        </div>

        <div className="mb-4">
          <div className="flex justify-between text-sm text-gray-500 mb-2">
            <span>问题 {currentStep + 1} / {questions.length}</span>
            <span>{Math.round(((currentStep + 1) / questions.length) * 100)}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div 
              className="bg-gradient-to-r from-blue-500 to-purple-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${((currentStep + 1) / questions.length) * 100}%` }}
            />
          </div>
        </div>

        <div className="mb-6">
          <h3 className="text-lg font-medium text-gray-800 mb-4">
            {currentQuestion.title}
          </h3>
          <div className="space-y-3">
            {currentQuestion.options.map((option, index) => (
              <button
                key={index}
                onClick={() => handleAnswer(currentQuestion.id, option)}
                className={`w-full p-3 rounded-lg border-2 text-left transition-all duration-200 ${
                  answers[currentQuestion.id] === option
                    ? 'border-purple-500 bg-purple-50 text-purple-700'
                    : 'border-gray-200 hover:border-purple-300 hover:bg-purple-50'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={handleNext}
          disabled={!answers[currentQuestion.id]}
          className="w-full bg-gradient-to-r from-blue-500 to-purple-500 text-white py-3 rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 hover:shadow-lg transition-all duration-200"
        >
          {currentStep === questions.length - 1 ? '完成问卷' : '下一题'}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

export default SurveySection;
